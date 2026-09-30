/**
 * reCAPTCHA v3 verification for the MUVE booking form.
 *
 * Lives in the same Apps Script project as Code.gs, whose doPost already calls
 * isHuman(). To turn it on: Project Settings → Script Properties → add
 * RECAPTCHA_SECRET_KEY = <your secret key>. Until then every booking is let through.
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
