(function () {
  "use strict";

  const MOVING_SIZES = [
    { id: "studio", label: "Studio / 1 room", base: 380 },
    { id: "1br", label: "1 bedroom", base: 520 },
    { id: "2br", label: "2 bedroom", base: 810 },
    { id: "3br", label: "3 bedroom", base: 1330 },
    { id: "4br", label: "4+ bedroom", base: 1900 }
  ];
  const JUNK_SIZES = [
    { id: "item", label: "Single item / minimum load", base: 80 },
    { id: "quarter", label: "1/4 truck load", base: 180 },
    { id: "half", label: "1/2 truck load", base: 330 },
    { id: "threeq", label: "3/4 truck load", base: 475 },
    { id: "full", label: "Full truck load", base: 620 }
  ];
  const ZONE_MULTIPLIERS = { "921": 1.0, "919": 1.0, "920": 1.0 };
  const DEFAULT_ZONE_MULTIPLIER = 1.2;
  const FAQ = [
    { q: "How does the instant quote work?", keywords: ["quote", "estimate", "price", "cost", "how much"], a: "Punch your ZIP code and job size into the calculator up top. We multiply a base rate by your zone to give you a price range in seconds — the final number is confirmed on-site." },
    { q: "What items do you accept?", keywords: ["accept", "items", "furniture", "appliance", "take", "junk", "what can"], a: "Furniture, appliances, yard waste, general household junk, and most bulky items. We can't take hazardous materials like paint, chemicals, or propane tanks." },
    { q: "What's your service area?", keywords: ["area", "zip", "location", "where", "cover"], a: "We cover San Diego County core ZIPs at standard rates, with outlying areas quoted at a small travel adjustment — enter your ZIP in the calculator to see your zone." },
    { q: "Do I need to be there for a junk pickup?", keywords: ["home", "present", "there", "during", "pickup"], a: "Someone 18+ needs to be on-site to point out what's going and confirm the final price before we load anything." },
    { q: "Can I cancel or reschedule?", keywords: ["cancel", "reschedule", "change date", "postpone"], a: "Yes — just call or email us at least 24 hours ahead and we'll move your slot, no fee." },
    { q: "Is a deposit required?", keywords: ["deposit", "pay", "payment", "upfront"], a: "No deposit to book. You pay the confirmed price after the job's done — cash, card, or online." }
  ];
  const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycby4MqBmuMY-1wmFcY3eeasnhW7XbvSHf8BptP6g1JoFnF8n5Hn4f5KYjC8_sA699bZwIQ/exec";
  const WINDOW_LABELS = { morning: "Morning (8am–11am)", midday: "Midday (11am–2pm)", afternoon: "Afternoon (2pm–5pm)" };
  // reCAPTCHA v3 site key (public) from google.com/recaptcha/admin — the only place it needs to be set.
  // Leave as "" to disable reCAPTCHA; the secret key goes in the Apps Script, never here.
  const RECAPTCHA_SITE_KEY = "";

  const state = {
    serviceType: "moving",
    quoteResult: null,
    chatOpened: false
  };

  const $ = (id) => document.getElementById(id);

  function getSizeList(type) {
    return type === "moving" ? MOVING_SIZES : JUNK_SIZES;
  }

  function getZoneMultiplier(zip) {
    const prefix = (zip || "").trim().slice(0, 3);
    return ZONE_MULTIPLIERS[prefix] ?? DEFAULT_ZONE_MULTIPLIER;
  }

  // ---- instant quote calculator ----

  function renderSizeOptions() {
    const list = getSizeList(state.serviceType);
    const select = $("quote-size");
    select.innerHTML = list.map((opt) => `<option value="${opt.id}">${opt.label}</option>`).join("");
    $("quote-size-label").textContent = state.serviceType === "moving" ? "Home size" : "Load size";
  }

  function setServiceType(type) {
    state.serviceType = type;
    $("quote-type-moving").classList.toggle("active", type === "moving");
    $("quote-type-junk").classList.toggle("active", type === "junk");
    renderSizeOptions();
    state.quoteResult = null;
    $("quote-result").classList.add("hidden");
  }

  function calculateQuote() {
    const list = getSizeList(state.serviceType);
    const sizeId = $("quote-size").value;
    const size = list.find((s) => s.id === sizeId) || list[0];
    const zip = $("quote-zip").value;
    const mult = getZoneMultiplier(zip);
    const low = Math.round((size.base * mult * 0.92) / 5) * 5;
    const high = Math.round((size.base * mult * 1.18) / 5) * 5;
    const zoneNote = zip && zip.length === 5
      ? (mult === 1 ? "core service area rate" : "standard travel rate applied")
      : "enter a ZIP for a zone-adjusted estimate";

    state.quoteResult = {
      low, high,
      rangeLabel: `$${low} – $${high}`,
      detail: `${size.label} · ${zoneNote}. Estimate only — final price is confirmed on-site.`
    };

    $("quote-result-range").textContent = state.quoteResult.rangeLabel;
    $("quote-result-detail").textContent = state.quoteResult.detail;
    $("quote-result").classList.remove("hidden");

    // carry the quote's service/zip into the booking form
    $("b-service").value = state.serviceType;
    if (zip) $("b-zip").value = zip;
  }

  // ---- booking form ----

  function loadRecaptcha() {
    if (!RECAPTCHA_SITE_KEY) return;
    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/api.js?render=" + encodeURIComponent(RECAPTCHA_SITE_KEY);
    script.async = true;
    document.head.appendChild(script);
  }

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

  async function handleBookingSubmit(e) {
    e.preventDefault();
    const b = {
      name: $("b-name").value.trim(),
      phone: $("b-phone").value.trim(),
      email: $("b-email").value.trim(),
      zip: $("b-zip").value.trim(),
      address: $("b-address").value.trim(),
      service: $("b-service").value,
      date: $("b-date").value,
      window: $("b-window").value,
      notes: $("b-notes").value.trim()
    };

    const errorEl = $("booking-error");
    if (!b.name || !b.phone || !b.email || !b.zip || !b.address || !b.date) {
      errorEl.textContent = "Please fill in all required fields.";
      errorEl.classList.remove("hidden");
      return;
    }
    errorEl.classList.add("hidden");

    const confNumber = "MUVE-" + Math.floor(100000 + Math.random() * 900000);
    const recaptchaToken = await getRecaptchaToken("booking_submit");
    const payload = { ...b, submittedAt: new Date().toISOString(), confNumber, recaptchaToken };

    fetch(APPS_SCRIPT_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload)
    }).catch(() => {});

    const dateLabel = b.date
      ? new Date(b.date + "T00:00:00").toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })
      : "";

    showConfirmation({
      confNumber,
      name: b.name,
      phone: b.phone,
      email: b.email,
      address: b.address,
      zip: b.zip,
      notes: b.notes,
      serviceLabel: b.service === "moving" ? "Moving" : "Junk & Trash Removal",
      dateLabel,
      windowLabel: WINDOW_LABELS[b.window] || b.window,
      priceLabel: state.quoteResult ? state.quoteResult.rangeLabel : "To be confirmed on-site"
    });
  }

  function showConfirmation(c) {
    $("conf-name").textContent = c.name;
    $("conf-number").textContent = c.confNumber;
    $("conf-service").textContent = c.serviceLabel;
    $("conf-date").textContent = c.dateLabel;
    $("conf-window").textContent = c.windowLabel;
    $("conf-price").textContent = c.priceLabel;
    $("conf-address").textContent = `${c.address}, ${c.zip}`;
    $("conf-email").textContent = c.email;
    $("conf-phone").textContent = c.phone;
    $("conf-window-2").textContent = c.windowLabel;
    $("conf-date-2").textContent = c.dateLabel;

    if (c.notes) {
      $("conf-notes").textContent = c.notes;
      $("conf-notes-wrap").classList.remove("hidden");
    } else {
      $("conf-notes-wrap").classList.add("hidden");
    }

    $("site-view").classList.add("hidden");
    $("confirmation-view").classList.remove("hidden");
    window.scrollTo(0, 0);
  }

  function backToSite() {
    $("confirmation-view").classList.add("hidden");
    $("site-view").classList.remove("hidden");
    window.scrollTo(0, 0);
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
    wrap.innerHTML = "";
    FAQ.slice(0, 4).forEach((f, i) => {
      const btn = document.createElement("button");
      btn.className = "chat-quick__btn";
      btn.textContent = f.q;
      btn.addEventListener("click", () => answerFaq(i));
      wrap.appendChild(btn);
    });
  }

  function answerFaq(i) {
    addChatMsg("user", FAQ[i].q);
    addChatMsg("bot", FAQ[i].a);
  }

  function setChatOpen(open) {
    $("chat-panel").classList.toggle("hidden", !open);
    if (open && !state.chatOpened) {
      state.chatOpened = true;
      addChatMsg("bot", "Hey — I can answer quick questions about pricing, service area, and booking. Pick one below or type your own.");
    }
  }

  function toggleChat() {
    setChatOpen($("chat-panel").classList.contains("hidden"));
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
      addChatMsg("bot", best ? best.a : "I'm not sure on that one — call (844) 867-0674 or email fam@muvepro.com and we'll get you a straight answer.");
    }, 300);
  }

  // ---- wiring ----

  document.addEventListener("DOMContentLoaded", () => {
    renderSizeOptions();
    loadRecaptcha();

    $("quote-type-moving").addEventListener("click", () => setServiceType("moving"));
    $("quote-type-junk").addEventListener("click", () => setServiceType("junk"));
    $("calculate-quote-btn").addEventListener("click", calculateQuote);

    $("booking-form").addEventListener("submit", handleBookingSubmit);
    $("back-to-site").addEventListener("click", backToSite);

    $("nav-faq").addEventListener("click", () => setChatOpen(true));
    $("chat-toggle").addEventListener("click", toggleChat);
    $("chat-close").addEventListener("click", () => setChatOpen(false));
    $("chat-send").addEventListener("click", sendChat);
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") sendChat();
    });

    renderQuickQuestions();
  });
})();
