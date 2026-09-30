/**
 * MUVE booking backend (Google Apps Script web app).
 *
 * What it does:
 *   1. Website booking comes in (doPost)
 *        → customer gets an email with their confirmation number
 *        → business inbox gets the request with a "Review & confirm" link
 *        → the request waits as "pending" until the owner decides
 *   2. Owner opens the link and clicks Confirm (or Decline)
 *        → Confirm: booking is added to that month's spreadsheet in the
 *          "MUVE Bookings" Drive folder and the customer gets a
 *          "booking confirmed" email
 *        → Decline: the customer gets a "we'll call you to find another time" email
 *   3. On the 1st of every month a new spreadsheet is created automatically
 *      ("MUVE Bookings – November 2026", …).
 *   4. No double booking: each date + time window holds CONFIG.JOBS_PER_SLOT jobs.
 *      Pending requests and confirmed bookings both hold their slot; a full slot
 *      is hidden on the website, rejected on submit, and blocked on confirm.
 *      To free a confirmed slot, set that row's Status to "Cancelled".
 *
 * Setup — see apps-script/SETUP.md.
 */

const CONFIG = {
  BUSINESS_EMAIL: 'fam@muvepro.com',
  BUSINESS_NAME: 'MUVE',
  BUSINESS_PHONE: '(844) 867-0674',
  FOLDER_NAME: 'MUVE Bookings',
  TIMEZONE: 'America/Los_Angeles',
  PENDING_DAYS: 60, // unanswered requests are cleared after this many days
  JOBS_PER_SLOT: 1   // max bookings per date + time window (raise to 2 if both crews can take the same window)
};

const HEADERS = [
  'Confirmation #', 'Status', 'Confirmed at', 'Job date', 'Time window', 'Service', 'Size',
  'Estimate', 'Name', 'Phone', 'Email', 'Pickup address', 'Pickup ZIP', 'Drop-off ZIP',
  'Notes', 'Submitted at'
];
const SERVICE_LABELS = { moving: 'Moving', delivery: 'Delivery', junk: 'Junk & Trash Removal' };
const WINDOW_LABELS = { morning: 'Morning (8am–11am)', midday: 'Midday (11am–2pm)', afternoon: 'Afternoon (2pm–5pm)' };

// ================= website → new booking request =================

const SCRIPT_VERSION = 'muve-bookings-2';

function doPost(e) {
  try {
    return handlePost_(e);
  } catch (err) {
    console.error('doPost failed: ' + (err && err.stack || err));
    return json_({ ok: false, reason: 'server', message: String(err && err.message || err).slice(0, 200) });
  }
}

function handlePost_(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, reason: 'invalid' });
  }
  if (!isHuman(data.recaptchaToken)) return json_({ ok: false, reason: 'rejected' });

  const b = cleanBooking_(data);
  if (!b) return json_({ ok: false, reason: 'invalid' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const dup = findDuplicatePending_(b);
    if (dup) return json_({ ok: true, confNumber: dup.confNumber }); // same request sent twice
    if (slotCount_(b.date, b.window) >= CONFIG.JOBS_PER_SLOT) return json_({ ok: false, reason: 'slot_taken' });
    if (getPending_(b.confNumber)) b.confNumber = newConfNumber_();
    savePending_(b);
  } finally {
    lock.releaseLock();
  }

  sendCustomerReceived_(b);
  sendOwnerRequest_(b);
  return json_({ ok: true, confNumber: b.confNumber });
}

// ================= owner review page =================

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'availability') {
    try {
      return json_({ ok: true, version: SCRIPT_VERSION, capacity: CONFIG.JOBS_PER_SLOT, full: fullSlots_() });
    } catch (err) {
      console.error('availability failed: ' + (err && err.stack || err));
      return json_({ ok: false, version: SCRIPT_VERSION, reason: 'server', message: String(err && err.message || err).slice(0, 200) });
    }
  }

  const id = String((e && e.parameter && e.parameter.id) || '');
  const token = String((e && e.parameter && e.parameter.t) || '');
  if (!id || !validToken_(id, token)) return page_('Link not valid', '<p>This review link is invalid or has been changed.</p>');

  const b = getPending_(id);
  if (!b) {
    return page_('Already handled', `<p>Booking <strong>${esc_(id)}</strong> has already been confirmed or declined, or the request has expired.</p>`);
  }

  const payload = JSON.stringify({ id: id, t: token }).replace(/</g, '\\u003c');
  const body = `
    ${bookingTable_(b)}
    <div class="actions">
      <button id="confirm" class="btn btn--go">Confirm &amp; add to spreadsheet</button>
      <button id="decline" class="btn btn--no">Decline</button>
    </div>
    <p id="result" class="result"></p>
    <script>
      var P = ${payload};
      function decide(action) {
        if (action === 'decline' && !confirm('Decline this booking? The customer will be emailed.')) return;
        document.getElementById('confirm').disabled = true;
        document.getElementById('decline').disabled = true;
        document.getElementById('result').textContent = 'Working…';
        google.script.run
          .withSuccessHandler(function (msg) { document.getElementById('result').innerHTML = msg; })
          .withFailureHandler(function (err) {
            document.getElementById('result').textContent = 'Something went wrong: ' + err.message;
            document.getElementById('confirm').disabled = false;
            document.getElementById('decline').disabled = false;
          })
          .processDecision(P.id, P.t, action);
      }
      document.getElementById('confirm').onclick = function () { decide('confirm'); };
      document.getElementById('decline').onclick = function () { decide('decline'); };
    </script>`;
  return page_(`Booking request ${esc_(id)}`, body);
}

/** Called from the review page. Returns an HTML message for the page. */
function processDecision(id, token, action) {
  if (!validToken_(id, token)) throw new Error('Invalid link.');
  if (action !== 'confirm' && action !== 'decline') throw new Error('Unknown action.');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let b, ss;
  try {
    b = getPending_(id);
    if (!b) return `Booking <strong>${esc_(id)}</strong> was already handled.`;
    if (action === 'confirm') {
      if (confirmedCount_(b.date, b.window) >= CONFIG.JOBS_PER_SLOT) {
        return `⚠️ Not confirmed: the ${esc_(WINDOW_LABELS[b.window])} slot on ${esc_(prettyDate_(b.date))} is already booked.
          Decline this request (the customer will be told you'll call to find another time), or mark the other booking "Cancelled" in the spreadsheet first.`;
      }
      ss = getMonthSpreadsheet_(jobDate_(b));
      appendBooking_(ss, b);
    }
    deletePending_(id);
  } finally {
    lock.releaseLock();
  }

  if (action === 'confirm') {
    sendCustomerConfirmed_(b);
    return `✅ Confirmed. The customer has been emailed and the booking was added to
      <a href="${ss.getUrl()}" target="_blank">${esc_(ss.getName())}</a>.`;
  }
  sendCustomerDeclined_(b);
  return '❌ Declined. The customer has been emailed that you will reach out to find another time.';
}

// ================= monthly spreadsheets =================

/** Runs on the 1st of each month (installed by setup). Creates this month's and next month's sheet. */
function createMonthlySheet() {
  const now = new Date();
  getMonthSpreadsheet_(now);
  getMonthSpreadsheet_(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  cleanupPending_();
}

function getMonthSpreadsheet_(date, noCreate) {
  const key = 'sheet:' + Utilities.formatDate(date, CONFIG.TIMEZONE, 'yyyy-MM');
  const name = CONFIG.FOLDER_NAME + ' – ' + Utilities.formatDate(date, CONFIG.TIMEZONE, 'MMMM yyyy');
  const props = PropertiesService.getScriptProperties();

  const cachedId = props.getProperty(key);
  if (cachedId) {
    try {
      const ss = SpreadsheetApp.openById(cachedId);
      if (!DriveApp.getFileById(cachedId).isTrashed()) return ss;
    } catch (err) { /* deleted — recreate below */ }
  }

  const folder = getFolder_();
  const found = folder.getFilesByName(name);
  let ss;
  if (found.hasNext()) {
    ss = SpreadsheetApp.openById(found.next().getId());
  } else if (noCreate) {
    return null;
  } else {
    ss = SpreadsheetApp.create(name);
    DriveApp.getFileById(ss.getId()).moveTo(folder);
    const sh = ss.getSheets()[0];
    sh.setName('Bookings');
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
      .setFontWeight('bold').setBackground('#F28C38').setFontColor('#102540');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, HEADERS.length);
  }
  props.setProperty(key, ss.getId());
  return ss;
}

function appendBooking_(ss, b) {
  const sh = ss.getSheetByName('Bookings') || ss.getSheets()[0];
  sh.appendRow([
    b.confNumber, 'Confirmed',
    Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    "'" + b.date, WINDOW_LABELS[b.window], SERVICE_LABELS[b.service], b.size, b.estimate,
    b.name, b.phone, b.email, b.address, b.zip, b.dropoffZip, b.notes, b.submittedAt
  ].map(sheetSafe_));
  // keep the month sorted by job date, then time window
  if (sh.getLastRow() > 2) sh.getRange(2, 1, sh.getLastRow() - 1, HEADERS.length).sort([{ column: 4 }, { column: 5 }]);
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('folderId');
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (err) { /* recreate */ }
  }
  const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('folderId', folder.getId());
  return folder;
}

// ================= double-booking protection =================

function slotKey_(date, window) {
  return date + '|' + window;
}

/** Confirmed (not cancelled) bookings per slot, read from the monthly spreadsheets. */
function confirmedCounts_(months) {
  const counts = {};
  const windowByLabel = {};
  Object.keys(WINDOW_LABELS).forEach(function (k) { windowByLabel[WINDOW_LABELS[k]] = k; });
  months.forEach(function (m) {
    const ss = getMonthSpreadsheet_(m, true);
    if (!ss) return;
    const sh = ss.getSheetByName('Bookings') || ss.getSheets()[0];
    if (sh.getLastRow() < 2) return;
    sh.getRange(2, 2, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {
      const status = String(r[0]).trim().toLowerCase();
      if (status === 'cancelled' || status === 'canceled') return;
      const date = r[2] instanceof Date ? Utilities.formatDate(r[2], CONFIG.TIMEZONE, 'yyyy-MM-dd') : String(r[2]).trim();
      const win = windowByLabel[String(r[3]).trim()] || String(r[3]).trim();
      const key = slotKey_(date, win);
      counts[key] = (counts[key] || 0) + 1;
    });
  });
  return counts;
}

/** Pending (waiting for owner) requests per slot. */
function pendingCounts_() {
  const counts = {};
  const all = PropertiesService.getScriptProperties().getProperties();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('pending:') !== 0) return;
    try {
      const p = JSON.parse(all[k]);
      const key = slotKey_(p.date, p.window);
      counts[key] = (counts[key] || 0) + 1;
    } catch (err) { /* ignore */ }
  });
  return counts;
}

function confirmedCount_(date, window) {
  return confirmedCounts_([dateFromIso_(date)])[slotKey_(date, window)] || 0;
}

function slotCount_(date, window) {
  const key = slotKey_(date, window);
  return confirmedCount_(date, window) + (pendingCounts_()[key] || 0);
}

/** Full slots for this month and the next three, as { "2026-10-20": ["morning", …] }. */
function fullSlots_() {
  const now = new Date();
  const months = [0, 1, 2, 3].map(function (i) { return new Date(now.getFullYear(), now.getMonth() + i, 1, 12); });
  const confirmed = confirmedCounts_(months);
  const pending = pendingCounts_();
  const full = {};
  Object.keys(confirmed).concat(Object.keys(pending)).forEach(function (key) {
    if ((confirmed[key] || 0) + (pending[key] || 0) < CONFIG.JOBS_PER_SLOT) return;
    const parts = key.split('|');
    full[parts[0]] = full[parts[0]] || [];
    if (full[parts[0]].indexOf(parts[1]) === -1) full[parts[0]].push(parts[1]);
  });
  return full;
}

function findDuplicatePending_(b) {
  const all = PropertiesService.getScriptProperties().getProperties();
  for (const k in all) {
    if (k.indexOf('pending:') !== 0) continue;
    try {
      const p = JSON.parse(all[k]);
      if (p.email.toLowerCase() === b.email.toLowerCase() && p.date === b.date && p.window === b.window && p.service === b.service) return p;
    } catch (err) { /* ignore */ }
  }
  return null;
}

// ================= emails =================

function sendCustomerReceived_(b) {
  MailApp.sendEmail({
    to: b.email,
    replyTo: CONFIG.BUSINESS_EMAIL,
    name: CONFIG.BUSINESS_NAME,
    subject: `We got your booking request — ${b.confNumber}`,
    htmlBody: emailShell_(`
      <p>Hi ${esc_(firstName_(b.name))},</p>
      <p>Thanks for choosing MUVE! We've received your request. Your confirmation number is:</p>
      <p class="big">${esc_(b.confNumber)}</p>
      ${bookingTable_(b)}
      <p><strong>What's next:</strong> we'll check the schedule and email you again once your time slot is confirmed. If we need to adjust the time, we'll call you at ${esc_(b.phone)}.</p>
      <p>Questions or changes? Reply to this email or call ${CONFIG.BUSINESS_PHONE}.</p>`),
    body: `Hi ${firstName_(b.name)},\n\nThanks for choosing MUVE! Your confirmation number is ${b.confNumber}.\n\n${bookingText_(b)}\n\nWe'll email you again once your time slot is confirmed. Questions? Reply to this email or call ${CONFIG.BUSINESS_PHONE}.`
  });
}

function sendOwnerRequest_(b) {
  const link = ScriptApp.getService().getUrl() + '?id=' + encodeURIComponent(b.confNumber) + '&t=' + token_(b.confNumber);
  MailApp.sendEmail({
    to: CONFIG.BUSINESS_EMAIL,
    replyTo: b.email,
    name: 'MUVE Website',
    subject: `New booking request ${b.confNumber} — ${SERVICE_LABELS[b.service]}, ${prettyDate_(b.date)}`,
    htmlBody: emailShell_(`
      <p><strong>New booking request from the website.</strong></p>
      ${bookingTable_(b)}
      <p><a class="btn" href="${link}">Review &amp; confirm</a></p>
      <p class="muted">Confirming adds it to the ${esc_(CONFIG.FOLDER_NAME)} spreadsheet and emails the customer. Reply to this email to write to the customer directly.</p>`),
    body: `New booking request ${b.confNumber}\n\n${bookingText_(b)}\n\nReview & confirm: ${link}`
  });
}

function sendCustomerConfirmed_(b) {
  MailApp.sendEmail({
    to: b.email,
    replyTo: CONFIG.BUSINESS_EMAIL,
    name: CONFIG.BUSINESS_NAME,
    subject: `Your MUVE booking is confirmed — ${b.confNumber}`,
    htmlBody: emailShell_(`
      <p>Hi ${esc_(firstName_(b.name))},</p>
      <p>Good news — your booking is <strong>confirmed</strong>. See you on ${esc_(prettyDate_(b.date))}!</p>
      <p class="big">${esc_(b.confNumber)}</p>
      ${bookingTable_(b)}
      <p>Our crew will arrive in your ${esc_(WINDOW_LABELS[b.window])} window. The final price is confirmed on-site before anything gets loaded. No deposit needed.</p>
      <p>Need to reschedule? It's free with 24 hours' notice — reply to this email or call ${CONFIG.BUSINESS_PHONE}.</p>`),
    body: `Hi ${firstName_(b.name)},\n\nYour MUVE booking ${b.confNumber} is confirmed.\n\n${bookingText_(b)}\n\nNeed to reschedule? Reply to this email or call ${CONFIG.BUSINESS_PHONE}.`
  });
}

function sendCustomerDeclined_(b) {
  MailApp.sendEmail({
    to: b.email,
    replyTo: CONFIG.BUSINESS_EMAIL,
    name: CONFIG.BUSINESS_NAME,
    subject: `About your MUVE request — ${b.confNumber}`,
    htmlBody: emailShell_(`
      <p>Hi ${esc_(firstName_(b.name))},</p>
      <p>Thanks for your request (${esc_(b.confNumber)}). Unfortunately we can't take the ${esc_(WINDOW_LABELS[b.window])} slot on ${esc_(prettyDate_(b.date))}.</p>
      <p>We'll reach out at ${esc_(b.phone)} to find another time that works — or reply to this email or call ${CONFIG.BUSINESS_PHONE}.</p>`),
    body: `Hi ${firstName_(b.name)},\n\nUnfortunately we can't take the ${WINDOW_LABELS[b.window]} slot on ${prettyDate_(b.date)} for request ${b.confNumber}. We'll reach out at ${b.phone} to find another time, or call ${CONFIG.BUSINESS_PHONE}.`
  });
}

function emailShell_(inner) {
  return `<div style="background:#FFF7EE;padding:24px;font-family:Arial,sans-serif;color:#102540">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;padding:24px;border:1px solid #EAD8C4">
      <div style="font-weight:800;font-size:22px;letter-spacing:1px;margin-bottom:12px">MUVE</div>
      ${inner
        .replace(/class="big"/g, 'style="font-size:26px;font-weight:800;color:#B84A17;margin:8px 0 16px"')
        .replace(/class="btn"/g, 'style="display:inline-block;background:#F28C38;color:#102540;font-weight:800;text-decoration:none;padding:12px 22px;border-radius:999px"')
        .replace(/class="muted"/g, 'style="color:#5b6470;font-size:13px"')}
      <p style="color:#5b6470;font-size:12px;margin-top:20px">MUVE · Moving · Delivery · Junk Removal · ${CONFIG.BUSINESS_PHONE} · ${CONFIG.BUSINESS_EMAIL}</p>
    </div></div>`;
}

function bookingRows_(b) {
  return [
    ['Service', SERVICE_LABELS[b.service] + (b.size ? ' · ' + b.size : '')],
    ['Date', prettyDate_(b.date)],
    ['Time window', WINDOW_LABELS[b.window]],
    ['Estimated price', b.estimate || 'Confirmed on-site'],
    ['Name', b.name],
    ['Phone', b.phone],
    ['Email', b.email],
    ['Pickup address', b.address + ', ' + b.zip],
    ['Drop-off ZIP', b.dropoffZip],
    ['Notes', b.notes]
  ].filter(function (r) { return r[1]; });
}

function bookingTable_(b) {
  return '<table style="border-collapse:collapse;width:100%;margin:12px 0;font-size:14px">' +
    bookingRows_(b).map(function (r) {
      return `<tr><td style="padding:6px 8px;color:#5b6470;border-bottom:1px solid #F3E6D8;white-space:nowrap">${esc_(r[0])}</td>` +
        `<td style="padding:6px 8px;font-weight:700;border-bottom:1px solid #F3E6D8">${esc_(r[1])}</td></tr>`;
    }).join('') + '</table>';
}

function bookingText_(b) {
  return bookingRows_(b).map(function (r) { return r[0] + ': ' + r[1]; }).join('\n');
}

function page_(title, body) {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      body{font-family:Arial,sans-serif;background:#FFF7EE;color:#102540;margin:0;padding:24px}
      .card{max-width:620px;margin:0 auto;background:#fff;border-radius:16px;padding:24px;border:1px solid #EAD8C4}
      h1{font-size:22px;margin:0 0 12px}
      .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
      .btn{border:0;border-radius:999px;padding:12px 20px;font-weight:800;font-size:15px;cursor:pointer}
      .btn--go{background:#F28C38;color:#102540}
      .btn--no{background:#fff;color:#B3261E;border:2px solid #B3261E}
      .btn:disabled{opacity:.5;cursor:wait}
      .result{margin-top:16px;font-weight:700}
    </style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
  return HtmlService.createHtmlOutput(html).setTitle('MUVE booking');
}

// ================= pending requests =================

function savePending_(b) {
  PropertiesService.getScriptProperties().setProperty('pending:' + b.confNumber, JSON.stringify(b));
}

function getPending_(id) {
  const raw = PropertiesService.getScriptProperties().getProperty('pending:' + id);
  return raw ? JSON.parse(raw) : null;
}

function deletePending_(id) {
  PropertiesService.getScriptProperties().deleteProperty('pending:' + id);
}

function cleanupPending_() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const cutoff = Date.now() - CONFIG.PENDING_DAYS * 24 * 3600 * 1000;
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('pending:') !== 0) return;
    try {
      if (new Date(JSON.parse(all[k]).receivedAt).getTime() < cutoff) props.deleteProperty(k);
    } catch (err) {
      props.deleteProperty(k);
    }
  });
}

// ================= validation & helpers =================

function cleanBooking_(d) {
  const s = function (v, max) { return String(v == null ? '' : v).trim().slice(0, max); };
  const b = {
    confNumber: s(d.confNumber, 20),
    name: s(d.name, 100),
    phone: s(d.phone, 30),
    email: s(d.email, 200),
    zip: s(d.zip, 5),
    dropoffZip: s(d.dropoffZip, 5),
    address: s(d.address, 200),
    service: s(d.service, 20),
    size: s(d.size, 80),
    estimate: s(d.estimate, 40),
    date: s(d.date, 10),
    window: s(d.window, 20),
    notes: s(d.notes, 2000),
    submittedAt: s(d.submittedAt, 40),
    receivedAt: new Date().toISOString()
  };
  if (!b.name || !b.phone || !b.address) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return null;
  if (!/^\d{5}$/.test(b.zip)) return null;
  if (b.dropoffZip && !/^\d{5}$/.test(b.dropoffZip)) b.dropoffZip = '';
  if (!SERVICE_LABELS[b.service] || !WINDOW_LABELS[b.window]) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date) || isNaN(jobDate_(b).getTime())) return null;
  if (!/^MUVE-\d{6}$/.test(b.confNumber)) b.confNumber = newConfNumber_();
  return b;
}

function newConfNumber_() {
  let id;
  do { id = 'MUVE-' + Math.floor(100000 + Math.random() * 900000); } while (getPending_(id));
  return id;
}

function secret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('linkSecret');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('linkSecret', secret);
  }
  return secret;
}

function token_(id) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(id, secret_())).replace(/=+$/, '');
}

function validToken_(id, token) {
  if (!/^MUVE-\d{6}$/.test(id) || !token) return false;
  const expected = token_(id);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function jobDate_(b) {
  return dateFromIso_(b.date);
}

function dateFromIso_(iso) {
  const p = iso.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2], 12);
}

function prettyDate_(iso) {
  const p = iso.split('-').map(Number);
  return Utilities.formatDate(new Date(p[0], p[1] - 1, p[2], 12), CONFIG.TIMEZONE, 'EEEE, MMMM d, yyyy');
}

function firstName_(name) {
  return String(name).split(/\s+/)[0] || 'there';
}

function esc_(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Stops customer text from being treated as a spreadsheet formula. */
function sheetSafe_(v) {
  const str = String(v == null ? '' : v);
  return /^[=+\-@]/.test(str) ? "'" + str : str;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ================= one-time setup =================

/**
 * Run this once from the Apps Script editor (select "setup" → Run).
 * It asks for permissions, creates the "MUVE Bookings" folder and this
 * month's spreadsheet, and schedules the monthly spreadsheet on the 1st.
 */
function setup() {
  secret_();
  getFolder_();
  createMonthlySheet();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'createMonthlySheet') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('createMonthlySheet').timeBased().onMonthDay(1).atHour(6).create();
  Logger.log('Setup done. Folder: ' + getFolder_().getUrl());
}

/** Optional: sends yourself a sample booking to check both emails. */
function sendTestBooking() {
  const b = cleanBooking_({
    confNumber: 'MUVE-000000', name: 'Test Customer', phone: CONFIG.BUSINESS_PHONE,
    email: CONFIG.BUSINESS_EMAIL, zip: '92101', dropoffZip: '92117', address: '123 Test St, San Diego',
    service: 'moving', size: 'Studio / 1 room', estimate: '$230 – $295',
    date: Utilities.formatDate(new Date(Date.now() + 7 * 864e5), CONFIG.TIMEZONE, 'yyyy-MM-dd'),
    window: 'morning', notes: 'This is a test booking.', submittedAt: new Date().toISOString()
  });
  savePending_(b);
  sendCustomerReceived_(b);
  sendOwnerRequest_(b);
  Logger.log('Test emails sent to ' + CONFIG.BUSINESS_EMAIL);
}
