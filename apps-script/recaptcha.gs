/**
 * reCAPTCHA v3 verification for the MUVE booking form.
 *
 * Setup (in the Apps Script project behind APPS_SCRIPT_URL):
 *   1. Paste this file into the project.
 *   2. Project Settings → Script Properties → add RECAPTCHA_SECRET_KEY = <your secret key>.
 *   3. At the top of doPost, after parsing the payload, add:
 *
 *        var payload = JSON.parse(e.postData.contents);
 *        if (!isHuman(payload.recaptchaToken)) {
 *          return ContentService.createTextOutput("rejected");
 *        }
 *
 *   4. Deploy → Manage deployments → edit → New version (so the live URL picks it up).
 *
 * The secret key must never go in script.js or anywhere in this repo.
 */

var RECAPTCHA_MIN_SCORE = 0.5; // 0.0 = bot, 1.0 = human; raise if spam gets through
var RECAPTCHA_ACTION = "booking_submit";

function isHuman(token) {
  var secret = PropertiesService.getScriptProperties().getProperty("RECAPTCHA_SECRET_KEY");
  if (!secret) return true; // not configured yet — don't drop bookings
  if (!token) return false;

  try {
    var res = UrlFetchApp.fetch("https://www.google.com/recaptcha/api/siteverify", {
      method: "post",
      payload: { secret: secret, response: token },
      muteHttpExceptions: true
    });
    var data = JSON.parse(res.getContentText());
    return data.success === true &&
      data.action === RECAPTCHA_ACTION &&
      data.score >= RECAPTCHA_MIN_SCORE;
  } catch (err) {
    return true; // Google unreachable — fail open rather than lose a real booking
  }
}
