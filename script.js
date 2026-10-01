(function () {
  "use strict";

  const SERVICES = {
    moving: {
      label: "Moving",
      sizeLabel: "Home size",
      needsDropoff: true,
      sizes: [
        { id: "studio", label: "Studio / 1 room", base: 250 },
        { id: "1br", label: "1 bedroom", base: 400 },
        { id: "2br", label: "2 bedroom", base: 690 },
        { id: "3br", label: "3 bedroom", base: 1210 },
        { id: "4br", label: "4+ bedroom", base: 1780 }
      ]
    },
    // Delivery rates are starting placeholders — adjust to MUVE's real pricing.
    delivery: {
      label: "Delivery",
      sizeLabel: "What are we delivering?",
      needsDropoff: true,
      sizes: [
        { id: "single", label: "Single item (couch, dresser…)", base: 95 },
        { id: "few", label: "2–4 items", base: 160 },
        { id: "small", label: "Small load (5+ items)", base: 260 }
      ]
    },
    junk: {
      label: "Junk & Trash Removal",
      sizeLabel: "Load size",
      needsDropoff: false,
      sizes: [
        { id: "item", label: "Single item / minimum load", base: 80 },
        { id: "quarter", label: "1/4 truck load", base: 180 },
        { id: "half", label: "1/2 truck load", base: 330 },
        { id: "threeq", label: "3/4 truck load", base: 475 },
        { id: "full", label: "Full truck load", base: 620 }
      ]
    }
  };
  // Gallery photos: put images in assets/gallery/ and list them here (newest first).
  const GALLERY = [
    { src: "assets/gallery/job-1.svg", caption: "Apartment move" },
    { src: "assets/gallery/job-2.svg", caption: "Couch delivery" },
    { src: "assets/gallery/job-3.svg", caption: "Garage clean-out" },
    { src: "assets/gallery/job-4.svg", caption: "Home move" },
    { src: "assets/gallery/job-5.svg", caption: "Junk haul-away" },
    { src: "assets/gallery/job-6.svg", caption: "Office move" }
  ];
  const ZONE_MULTIPLIERS = { "921": 1.0, "919": 1.0, "920": 1.0 };
  const DEFAULT_ZONE_MULTIPLIER = 1.2;
  const FAQ = [
    { q: "How does the instant quote work?", keywords: ["quote", "estimate", "price", "cost", "how much"], a: "Pick a service and drop in your ZIP code and job size. We multiply a base rate by your zone to give you a price range in seconds — the final number is confirmed on-site." },
    { q: "What items do you accept?", keywords: ["accept", "items", "furniture", "appliance", "take", "junk", "what can"], a: "Furniture, appliances, yard waste, general household junk, and most bulky items. We can't take hazardous materials like paint, chemicals, or propane tanks." },
    { q: "What's your service area?", keywords: ["area", "zip", "location", "where", "cover"], a: "We cover San Diego County core ZIPs at standard rates, with outlying areas quoted at a small travel adjustment — enter your ZIP to see your zone." },
    { q: "Do I need to be there?", keywords: ["home", "present", "there", "during", "pickup"], a: "Someone 18+ needs to be on-site to point out what's going and confirm the final price before we load anything." },
    { q: "Can I cancel or reschedule?", keywords: ["cancel", "reschedule", "change date", "postpone"], a: "Yes — just call or email us at least 24 hours ahead and we'll move your slot, no fee." },
    { q: "Is a deposit required?", keywords: ["deposit", "pay", "payment", "upfront"], a: "No deposit to book. You pay the confirmed price after the job's done — cash, card, or online." }
  ];
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzA2mgTlSMYKrPiMcznpA3zszZ9QKR0uGsS3RXLJPA_3tEBeXiMkcrQJTDao4d_I2b8mw/exec";
  const WINDOW_LABELS = { morning: "Morning (8am–11am)", midday: "Midday (11am–2pm)", afternoon: "Afternoon (2pm–5pm)" };
  // reCAPTCHA v3 site key (public) from google.com/recaptcha/admin — the only place it needs to be set.
  // Leave as "" to disable reCAPTCHA; the secret key goes in the Apps Script, never here.
  const RECAPTCHA_SITE_KEY = "";
  const PREVIEW = false; // true only in the offline preview copy: nothing is sent to the Apps Script

  const state = {
    serviceType: "moving",
    step: 1,
    quoteResult: null,
    fullSlots: {}, // { "2026-10-20": ["morning", ...] } — slots already taken
    availabilityLoaded: false,
    chatOpened: false
  };

  const $ = (id) => document.getElementById(id);
  const ZIP_RE = /^\d{5}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function getZoneMultiplier(zip) {
    const prefix = (zip || "").trim().slice(0, 3);
    return ZONE_MULTIPLIERS[prefix] ?? DEFAULT_ZONE_MULTIPLIER;
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  // ---- step 1: service & size ----

  function renderSizeOptions(preselect) {
    const svc = SERVICES[state.serviceType];
    $("b-size").innerHTML = svc.sizes.map((opt) => `<option value="${opt.id}">${opt.label}</option>`).join("");
    if (preselect) $("b-size").value = preselect;
    $("b-size-label").textContent = svc.sizeLabel;
    $("b-zip-label").textContent = svc.needsDropoff ? "Pickup ZIP" : "Your ZIP";
    $("dropoff-field").classList.toggle("hidden", !svc.needsDropoff);
  }

  function setServiceType(type, preselectSize) {
    state.serviceType = type;
    document.querySelectorAll(".service-pill").forEach((btn) => {
      const on = btn.dataset.service === type;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", on ? "true" : "false");
    });
    renderSizeOptions(preselectSize);
    state.quoteResult = null;
  }

  function calculateQuote() {
    const svc = SERVICES[state.serviceType];
    const size = svc.sizes.find((s) => s.id === $("b-size").value) || svc.sizes[0];
    const zip = $("b-zip").value.trim();
    const mult = getZoneMultiplier(zip);
    const low = Math.round((size.base * mult * 0.92) / 5) * 5;
    const high = Math.round((size.base * mult * 1.18) / 5) * 5;
    const zoneNote = mult === 1 ? "core service area rate" : "standard travel rate applied";

    state.quoteResult = {
      low, high,
      sizeLabel: size.label,
      rangeLabel: `$${low} – $${high}`,
      detail: `${svc.label} · ${size.label} · ${zoneNote}. Final price is confirmed on-site.`
    };
    $("quote-result-range").textContent = state.quoteResult.rangeLabel;
    $("quote-result-detail").textContent = state.quoteResult.detail;
  }

  // ---- availability (double-booking protection) ----

  async function loadAvailability() {
    if (PREVIEW) return;
    try {
      const res = await fetch(APPS_SCRIPT_URL + "?action=availability");
      const data = await res.json();
      if (data && data.ok && data.full) {
        Object.keys(data.full).forEach((date) => {
          state.fullSlots[date] = Array.from(new Set((state.fullSlots[date] || []).concat(data.full[date])));
        });
        state.availabilityLoaded = true;
        updateWindowOptions();
      }
    } catch (_) {
      // couldn't check — the server still rejects a taken slot on submit
    }
  }

  function isSlotFull(date, win) {
    return (state.fullSlots[date] || []).includes(win);
  }

  function updateWindowOptions() {
    const date = $("b-date").value;
    const select = $("b-window");
    let firstOpen = null;
    Array.from(select.options).forEach((opt) => {
      const full = !!date && isSlotFull(date, opt.value);
      opt.disabled = full;
      opt.textContent = WINDOW_LABELS[opt.value] + (full ? " — fully booked" : "");
      if (!full && firstOpen === null) firstOpen = opt.value;
    });
    if (select.selectedOptions[0] && select.selectedOptions[0].disabled && firstOpen) select.value = firstOpen;
    if (date && firstOpen === null) showError("step2-error", "That day is fully booked — please pick another date.");
  }

  // ---- wizard navigation ----

  function validateStep(step) {
    if (step === 1) {
      const zip = $("b-zip").value.trim();
      const drop = $("b-dropoff-zip").value.trim();
      if (!ZIP_RE.test(zip)) return ["step1-error", "Please enter a 5-digit ZIP code."];
      if (SERVICES[state.serviceType].needsDropoff && drop && !ZIP_RE.test(drop)) return ["step1-error", "Drop-off ZIP should be 5 digits (or leave it blank)."];
    }
    if (step === 2) {
      const date = $("b-date").value;
      if (!date) return ["step2-error", "Please pick a preferred date."];
      if (date < $("b-date").min) return ["step2-error", "Please pick a date from today onward."];
      if (isSlotFull(date, $("b-window").value)) return ["step2-error", "That time is already booked — please pick another time or date."];
    }
    if (step === 3) {
      const name = $("b-name").value.trim(), phone = $("b-phone").value.trim();
      const email = $("b-email").value.trim(), addr = $("b-address").value.trim();
      if (!name || !phone || !email || !addr) return ["booking-error", "Please fill in your name, phone, email and address."];
      if (!EMAIL_RE.test(email)) return ["booking-error", "That email address doesn't look right."];
    }
    return null;
  }

  function goToStep(step) {
    if (step > state.step) {
      for (let s = state.step; s < step; s++) {
        const err = validateStep(s);
        if (err) { showError(err[0], err[1]); return; }
        showError(["step1-error", "step2-error", "booking-error"][s - 1], "");
      }
    }
    if (step === 2) {
      calculateQuote();
      loadAvailability();
    }
    state.step = step;
    document.querySelectorAll(".step").forEach((fs) => fs.classList.toggle("hidden", Number(fs.dataset.step) !== step));
    document.querySelectorAll("[data-step-dot]").forEach((dot) => {
      const n = Number(dot.dataset.stepDot);
      dot.classList.toggle("is-active", n === step);
      dot.classList.toggle("is-done", n < step);
    });
    const first = document.querySelector(`.step[data-step="${step}"] input, .step[data-step="${step}"] select`);
    if (first && step > 1) first.focus({ preventScroll: true });
  }

  function scrollToBooking() {
    $("book").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---- submit ----

  function getRecaptchaToken(action) {
    return new Promise((resolve) => {
      if (!RECAPTCHA_SITE_KEY || typeof grecaptcha === "undefined") {
        resolve(null); // site key not configured yet, or the script was blocked (ad blockers, offline) — don't hold up the form
        return;
      }
      const fallback = setTimeout(() => resolve(null), 4000);
      grecaptcha.ready(() => {
        grecaptcha.execute(RECAPTCHA_SITE_KEY, { action })
          .then((token) => { clearTimeout(fallback); resolve(token); })
          .catch(() => { clearTimeout(fallback); resolve(null); });
      });
    });
  }

  function loadRecaptcha() {
    if (!RECAPTCHA_SITE_KEY) return;
    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(RECAPTCHA_SITE_KEY);
    script.async = true;
    document.head.appendChild(script);
  }

  async function handleBookingSubmit(e) {
    e.preventDefault();
    if (state.step !== 3) { goToStep(state.step + 1); return; }
    const err = validateStep(3);
    if (err) { showError(err[0], err[1]); return; }
    showError("booking-error", "");

    const svc = SERVICES[state.serviceType];
    const b = {
      name: $("b-name").value.trim(),
      phone: $("b-phone").value.trim(),
      email: $("b-email").value.trim(),
      zip: $("b-zip").value.trim(),
      dropoffZip: svc.needsDropoff ? $("b-dropoff-zip").value.trim() : "",
      address: $("b-address").value.trim(),
      service: state.serviceType,
      size: state.quoteResult ? state.quoteResult.sizeLabel : "",
      estimate: state.quoteResult ? state.quoteResult.rangeLabel : "",
      date: $("b-date").value,
      window: $("b-window").value,
      notes: $("b-notes").value.trim()
    };

    const btn = $("submit-btn");
    btn.disabled = true;
    btn.textContent = "Sending…";

    const recaptchaToken = await getRecaptchaToken("booking_submit");
    const payload = { ...b, submittedAt: new Date().toISOString(), recaptchaToken };
    const result = await sendBooking(payload);

    btn.disabled = false;
    btn.textContent = "Request booking";

    if (!result.ok) {
      if (result.reason === "slot_taken") {
        state.fullSlots[b.date] = (state.fullSlots[b.date] || []).concat(b.window);
        goToStep(2);
        updateWindowOptions();
        showError("step2-error", "Sorry — someone just booked that time. Please pick another time or date.");
        loadAvailability();
        return;
      }
      const code = result.reason + (result.status ? "-" + result.status : "") + (result.message ? ": " + result.message : "");
      showError("booking-error", (result.reason === "network"
        ? "We couldn't send your request — please check your connection and try again, or call (619) 713-8841."
        : "We couldn't process your request. Please check your details or call (619) 713-8841.") + " (Error code: " + code + ")");
      return;
    }
    const confNumber = result.confNumber;

    const dateLabel = new Date(b.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    showConfirmation({
      confNumber,
      name: b.name,
      phone: b.phone,
      email: b.email,
      address: `${b.address}, ${b.zip}`,
      notes: b.notes,
      serviceLabel: b.size ? `${svc.label} · ${b.size}` : svc.label,
      dateLabel,
      windowLabel: WINDOW_LABELS[b.window] || b.window,
      priceLabel: b.estimate || "To be confirmed on-site"
    });
  }

  async function sendBooking(payload) {
    if (PREVIEW) return { ok: true, confNumber: "MUVE-" + Math.floor(100000 + Math.random() * 900000) };
    try {
      const res = await fetch(APPS_SCRIPT_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload)
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (_) { return { ok: false, reason: "not-json", status: res.status }; }
      return data && typeof data.ok === "boolean" ? data : { ok: false, reason: "not-json", status: res.status };
    } catch (_) {
      return { ok: false, reason: "network" };
    }
  }

  function showConfirmation(c) {
    $("conf-name").textContent = c.name;
    $("conf-number").textContent = c.confNumber;
    $("conf-service").textContent = c.serviceLabel;
    $("conf-date").textContent = c.dateLabel;
    $("conf-window").textContent = c.windowLabel;
    $("conf-price").textContent = c.priceLabel;
    $("conf-address").textContent = c.address;
    $("conf-email").textContent = c.email;
    $("conf-phone").textContent = c.phone;
    $("conf-window-2").textContent = c.windowLabel;
    $("conf-date-2").textContent = c.dateLabel;
    $("conf-notes").textContent = c.notes;
    $("conf-notes-wrap").classList.toggle("hidden", !c.notes);

    $("site-view").classList.add("hidden");
    $("confirmation-view").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function backToSite() {
    $("booking-form").reset();
    setServiceType("moving");
    goToStep(1);
    $("confirmation-view").classList.add("hidden");
    $("site-view").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  // ---- pricing & faq sections ----

  function renderPricing() {
    const order = ["moving", "delivery", "junk"];
    $("price-grid").innerHTML = order.map((key) => {
      const svc = SERVICES[key];
      const from = Math.min(...svc.sizes.map((s) => s.base));
      const rows = svc.sizes.map((s) => `<li><span>${s.label}</span><span>from $${s.base}</span></li>`).join("");
      const featured = key === "moving";
      return `<div class="price-card${featured ? " price-card--featured" : ""}">
        ${featured ? '<span class="price-card__badge">Most booked</span>' : ""}
        <h3 class="price-card__title">${svc.label}</h3>
        <p class="price-card__from">Starting at <strong>$${from}</strong></p>
        <ul>${rows}</ul>
        <button type="button" class="btn btn--primary btn--full" data-pick="${key}">Get my price</button>
      </div>`;
    }).join("");
  }

  function renderFaq() {
    const list = $("faq-list");
    FAQ.forEach((f) => {
      const d = document.createElement("details");
      const s = document.createElement("summary");
      const p = document.createElement("p");
      s.textContent = f.q;
      p.textContent = f.a;
      d.append(s, p);
      list.appendChild(d);
    });
  }

  // ---- gallery ----

  let galleryIndex = 0;

  function renderGallery() {
    const grid = $("gallery-grid");
    GALLERY.forEach((item, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "gallery-item";
      btn.setAttribute("aria-label", "View photo: " + item.caption);
      const img = document.createElement("img");
      img.src = item.src;
      img.alt = item.caption;
      img.loading = "lazy";
      const cap = document.createElement("span");
      cap.className = "gallery-item__caption";
      cap.textContent = item.caption;
      btn.append(img, cap);
      btn.addEventListener("click", () => openLightbox(i));
      grid.appendChild(btn);
    });
  }

  function showLightboxImage() {
    const item = GALLERY[galleryIndex];
    $("lightbox-img").src = item.src;
    $("lightbox-img").alt = item.caption;
    $("lightbox-caption").textContent = `${item.caption} · ${galleryIndex + 1} of ${GALLERY.length}`;
  }

  function openLightbox(i) {
    galleryIndex = i;
    showLightboxImage();
    $("lightbox").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    $("lightbox-close").focus();
  }

  function closeLightbox() {
    $("lightbox").classList.add("hidden");
    document.body.style.overflow = "";
  }

  function stepLightbox(dir) {
    galleryIndex = (galleryIndex + dir + GALLERY.length) % GALLERY.length;
    showLightboxImage();
  }

  // ---- chat widget ----

  function addChatMsg(who, text) {
    const div = document.createElement("div");
    div.className = "chat-msg " + (who === "bot" ? "chat-msg--bot" : "chat-msg--user");
    div.textContent = text;
    $("chat-messages").appendChild(div);
    $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
  }

  function renderQuickQuestions() {
    const wrap = $("chat-quick");
    FAQ.slice(0, 4).forEach((f, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chat-quick__btn";
      btn.textContent = f.q;
      btn.addEventListener("click", () => { addChatMsg("user", FAQ[i].q); addChatMsg("bot", FAQ[i].a); });
      wrap.appendChild(btn);
    });
  }

  function setChatOpen(open) {
    $("chat-panel").classList.toggle("hidden", !open);
    if (open && !state.chatOpened) {
      state.chatOpened = true;
      addChatMsg("bot", "Hey — I can answer quick questions about pricing, service area, and booking. Pick one below or type your own.");
    }
  }

  function sendChat() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text) return;
    addChatMsg("user", text);
    input.value = "";
    const lower = text.toLowerCase();
    let best = null, bestScore = 0;
    FAQ.forEach((f) => {
      const score = f.keywords.filter((k) => lower.includes(k)).length;
      if (score > bestScore) { bestScore = score; best = f; }
    });
    setTimeout(() => {
      addChatMsg("bot", best ? best.a : "I'm not sure on that one — call (619) 713-8841 or email fam@muvepro.com and we'll get you a straight answer.");
    }, 300);
  }

  // ---- wiring ----

  document.addEventListener("DOMContentLoaded", () => {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    $("b-date").min = today.toISOString().slice(0, 10);

    renderSizeOptions();
    renderPricing();
    renderFaq();
    renderGallery();
    renderQuickQuestions();
    loadRecaptcha();

    document.querySelectorAll(".service-pill").forEach((btn) =>
      btn.addEventListener("click", () => setServiceType(btn.dataset.service)));

    document.addEventListener("click", (e) => {
      const next = e.target.closest("[data-next]");
      const back = e.target.closest("[data-back]");
      const pick = e.target.closest("[data-pick]");
      const scroll = e.target.closest("[data-scroll-booking]");
      if (next) goToStep(Number(next.dataset.next));
      else if (back) goToStep(Number(back.dataset.back));
      else if (pick) {
        setServiceType(pick.dataset.pick, pick.dataset.size);
        goToStep(1);
        scrollToBooking();
        $("b-zip").focus({ preventScroll: true });
      } else if (scroll) {
        e.preventDefault();
        scrollToBooking();
      }
    });

    $("booking-form").addEventListener("submit", handleBookingSubmit);
    $("b-date").addEventListener("change", updateWindowOptions);
    $("booking-form").addEventListener("input", () => ["step1-error", "step2-error", "booking-error"].forEach((id) => showError(id, "")));
    $("back-to-site").addEventListener("click", backToSite);

    $("lightbox-close").addEventListener("click", closeLightbox);
    $("lightbox-prev").addEventListener("click", () => stepLightbox(-1));
    $("lightbox-next").addEventListener("click", () => stepLightbox(1));
    $("lightbox").addEventListener("click", (e) => { if (e.target === $("lightbox")) closeLightbox(); });
    document.addEventListener("keydown", (e) => {
      if ($("lightbox").classList.contains("hidden")) return;
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowLeft") stepLightbox(-1);
      else if (e.key === "ArrowRight") stepLightbox(1);
    });

    $("chat-toggle").addEventListener("click", () => setChatOpen($("chat-panel").classList.contains("hidden")));
    $("chat-close").addEventListener("click", () => setChatOpen(false));
    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
  });
})();
