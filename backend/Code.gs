/**
 * Ravi's Student Guest House — backend v6-native
 * ==============================================
 * Google Apps Script backend for ravisguesthouse.com.
 *
 * SOURCE OF TRUTH (v6-native change): the Bookings sheet — NOT Google
 * Calendar. Only Confirmed and Maintenance bookings block dates.
 * Pending, Denied and Cancelled do NOT block. Move-out is the first
 * unblocked date (a new stay may start on the previous guest's
 * move-out day). Google Calendar is an OPTIONAL outbound sync only:
 * Sheets are committed first; a Calendar failure leaves the native
 * reservation valid and flags it for retry.
 *
 * RECONSTRUCTION NOTICE: the v5 source could NOT be recovered
 * (Chuck, Nov 11 2026). This file was reconstructed from:
 *  - the live ?action=admin dashboard HTML (admin-reference-2026-11-11.html)
 *  - the live public API behaviour observed Nov 11 2026
 *    (GET availability / ?action=rates / ?action=quote / ?action=admin)
 *  - Chuck's Nov 11 2026 handover (exact schema, deployment, auth rules)
 *  - the public frontend (index.html / reviews.html) request shapes
 * It is NOT the v5 source. Before deploying, retrieve the authoritative
 * v5 source if access allows:
 *   GET https://script.googleapis.com/v1/projects/
 *     1jAxus9CbLHOzMM3W3-sPAjE93eYsPqFTVyROAa9jxK9oFmHP3jHtOmd0/
 *     content?versionNumber=5
 * and diff it against this file. Anything that differs in sheet layout,
 * API shape or auth must be reconciled BEFORE cutover — see README.md.
 *
 * EXACT SCHEMA (Chuck, Nov 11 2026 — do not change without Jag/Rob):
 *   Spreadsheet "Ravi Guest House Booking Requests".
 *   Its ID lives in script property BOOKING_SPREADSHEET_ID.
 *   Tabs / columns (1-based, header row 1):
 *     Booking Requests (A–P):
 *       Submitted | Booking ID | Status | Room | Move-in | Move-out |
 *       Nights | Name | Email | Guest type | Contact preference | Bike |
 *       Payment preference | Payment method | Notes | Source
 *     Review Submissions (A–L):
 *       Submitted | Review ID | Status | Name | Email | Room | Rating |
 *       Stay began | Stay ended | Attribution | Review | Source
 *     Admin Audit (A–D):
 *       Time | Administrator | Action | Reference
 *   Rates / pricing are NOT in Sheets:
 *     ROOM_RATES — script property, room->monthly-rate JSON.
 *     BILLING_DAYS — script property, 30 or 31 (default 30).
 *   Calendar event mappings are NOT sheet columns:
 *     BOOKING_EVENT_<bookingId> — script property "calendarId|eventId".
 *   Calendar IDs (optional sync only):
 *     CALENDAR_ROOM_1 … CALENDAR_ROOM_10 — script properties.
 *   VERIFIED calendar IDs (Nov 11 2026, read via rainer1370@gmail.com
 *   as READER only — the backend account rob@controllattice.com cannot
 *   see these calendars at all; that is the root cause of the v5
 *   "calendar not connected" failure):
 *     Room 1  2efa9ab53afc766921cdaef15d85869ab8f1fb0643539118fe12b4278a57f716@group.calendar.google.com
 *     Room 2  f030de575f1eb177f14e5ffda1005d04dc61747facf7fe6ef5aa22798cf21407@group.calendar.google.com
 *     Room 3  551a056b8348277394ccb6a51442872136f305f8fa14a9d2c49ac3d4dc719bf3@group.calendar.google.com
 *     Room 4  e7aeb2c13a0c54e63128aef76d85851c38ba312fc7f4361f61dd8ce65365cbaf@group.calendar.google.com
 *     Room 5  d654f3737954aa747d1899ac11f71b2589e3b759e2ad32d739a309ca1584feff@group.calendar.google.com
 *     Room 6  3a8112e48e9995336de692ff9c4f8782ad9a01ec556d4fc81966017f93f67cd7@group.calendar.google.com
 *     Room 7  cdc0e924cfdb7bac594f924106724013c3c1af54447ab11e797eb0375a36dafa@group.calendar.google.com
 *     Room 8  5709548a892e030fb9ef5d04347830a176b1bda1d3f1045f00a7f5a9b81e8b9b@group.calendar.google.com
 *     Room 9  58f34ae3d3f045c831f62f2ec049446f3650892b832771fdcda3d89b4da32b43@group.calendar.google.com
 *     Room 10 e740e2daa9fa3f9fdd4d0dfc631751a1c22f4e94dcaa5852834bc63f22b730fd@group.calendar.google.com
 *   These IDs are documentation only — they are NOT read by the code.
 *   Set them as CALENDAR_ROOM_* properties only if/when Jag wants
 *   outbound sync or a one-off import, and only after the calendars
 *   have been shared with the executing account (rob@) — see README.
 *
 * DEPLOYMENT (v5, preserved): Execute as me (rob@controllattice.com),
 * Who has access: Anyone. Google-identity admin is an EXACT match on
 * rob@controllattice.com only (adminIdentity_). Jag signs in with his
 * username (his Google address, rgh.cleveland@gmail.com) AND the
 * administrator password (adminLogin / adminSetPassword). A password
 * was set Nov 11 2026; its value is stored only as a hash, never here.
 *
 * SITE-HOSTED ADMIN (admin.html on ravisguesthouse.com): the same
 * dashboard is also served as a static page on the website, because
 * Google unreliably serves ?action=admin to browsers signed into
 * multiple/other Google accounts. That page reaches these functions
 * through the POST action=admin-api JSON transport (adminApiResponse_)
 * with the same username + password credentials; there is no Google
 * identity on that path, so the rob@ auto-allow does not apply there.
 * The Apps Script-served dashboard is unchanged and remains Rob's
 * backdoor.
 *
 * DO NOT run setupBackend() blindly to "find" the spreadsheet: this
 * v6 version never creates a spreadsheet. If BOOKING_SPREADSHEET_ID
 * is missing it returns an error telling Rob how to set it.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

var ADMIN_GOOGLE_EMAIL = 'rob@controllattice.com';
var JAG_EMAIL = 'rgh.cleveland@gmail.com';
/** Jag's admin username: his Google address. Password sign-in requires
 *  this username AND the administrator password (adminLogin). */
var ADMIN_USERNAME = 'rgh.cleveland@gmail.com';
var ROB_EMAIL = 'rob@controllattice.com';
var MIN_NIGHTS = 21;

var DEFAULT_RATES = { '1': 900, '2': 750, '3': 900, '4': 900, '5': 900,
  '6': 750, '7': 900, '8': 925, '9': 925, '10': 925 };

/** Pricing defaults (live v5 values). 4% applies to rent + cleaning +
 *  refundable deposit unless Jag changes feeOnDeposit. See README. */
var DEFAULT_PRICING = {
  cleaningFee: 15,
  securityDeposit: 50,
  transactionFeePercent: 4,
  reservationPayment: 100,
  taxPercent: 0,
  daysPerMonth: 30,
  feeOnDeposit: true,
  feeWaivedMethods: ['Venmo', 'Zelle', 'Cash']
};

var BOOKING_HEADERS = ['Submitted', 'Booking ID', 'Status', 'Room',
  'Move-in', 'Move-out', 'Nights', 'Name', 'Email', 'Guest type',
  'Contact preference', 'Bike', 'Payment preference', 'Payment method',
  'Notes', 'Source'];
var REVIEW_HEADERS = ['Submitted', 'Review ID', 'Status', 'Name', 'Email',
  'Room', 'Rating', 'Stay began', 'Stay ended', 'Attribution', 'Review',
  'Source'];
var AUDIT_HEADERS = ['Time', 'Administrator', 'Action', 'Reference'];

var BLOCKING_STATUSES = ['Confirmed', 'Maintenance'];
var TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6 hours, as in v5
var LOGIN_MAX_ATTEMPTS = 5;
var LOGIN_LOCK_SECONDS = 2 * 60; // 2-minute lockout (Rob, Nov 12, 2026)
var LINK_LOGIN_MAX_ATTEMPTS = 10;
var LINK_LOGIN_LOCK_SECONDS = 30 * 60; // personal-link sign-in lockout
var HASH_ITERATIONS = 1000;

// ---------------------------------------------------------------------------
// HTTP entry points — public routes (unchanged from v5)
// ---------------------------------------------------------------------------

function doGet(e) {
  e = e || {};
  var p = (e.parameter) || {};
  try {
    var action = String(p.action || '');
    if (action === 'admin') return adminHtmlOutput_();
    if (action === 'reset-lockout') return resetLockoutResponse_();
    if (action === 'rates') return json_(getRatesResponse_());
    if (action === 'quote') return json_(quoteResponse_(p));
    if (action === 'reviews') return json_(getApprovedReviews_());
    // Default: availability for a date range.
    return json_(getAvailability_(p.start, p.end));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  e = e || {};
  var p = (e.parameter) || {};
  try {
    var action = String(p.action || '');
    if (action === 'booking') return json_(submitBooking_(p));
    if (action === 'review') return json_(submitReview_(p));
    if (action === 'admin-api') return json_(adminApiResponse_(p));
    return json_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

// ---------------------------------------------------------------------------
// Public API: availability (native source of truth)
// ---------------------------------------------------------------------------

/**
 * Availability for [start, end). Only Confirmed / Maintenance block.
 * If the sheet cannot be read, every room is reported unavailable to
 * verify (available:false, sheetError set) — NEVER stale fallback dates.
 */
function getAvailability_(start, end) {
  var range = normaliseRange_(start, end);
  var rooms = [];
  var sheetError = null;
  var bookings = [];
  try {
    bookings = readBookings_();
  } catch (err) {
    sheetError = String(err && err.message || err);
  }
  for (var id = 1; id <= 10; id++) {
    if (sheetError) {
      rooms.push({ id: id, available: false, calendarFound: false,
        blocked: [], source: 'native', sheetError: sheetError,
        unavailableToVerify: true });
      continue;
    }
    var blocked = blockingRanges_(bookings, id, range.start, range.end);
    rooms.push({ id: id,
      available: !overlapsAny_(blocked, range.start, range.end),
      calendarFound: true, connected: true, source: 'native',
      blocked: blocked });
  }
  var out = { ok: true, rooms: rooms, source: 'native' };
  if (sheetError) out.sheetError = sheetError;
  return out;
}

function getRatesResponse_() {
  var rates = getRates_();
  var pricing = getPricing_();
  var rooms = [];
  for (var id = 1; id <= 10; id++) {
    rooms.push({ id: id, rate: rates[String(id)] });
  }
  return { ok: true, rates: rates, rooms: rooms, pricing: pricing,
    billingDays: pricing.daysPerMonth };
}

function quoteResponse_(p) {
  try {
    var q = computeQuote_(p.room, p.moveIn, p.moveOut, p.paymentMethod);
    q.ok = true;
    return q;
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function getApprovedReviews_() {
  var rows = readReviews_();
  var out = [];
  rows.forEach(function (r) {
    if (String(r.status || '') !== 'Approved') return;
    out.push({ review: r.review, displayName: resolveDisplayName_(r.name, r.attribution),
      rating: Number(r.rating) || 0, room: r.room,
      stayFrom: r.stayFrom, stayTo: r.stayTo, attribution: r.attribution });
  });
  return { ok: true, reviews: out };
}

// ---------------------------------------------------------------------------
// Public API: booking / review submission
// ---------------------------------------------------------------------------

function submitBooking_(p) {
  var roomRaw = String(p.room || '').trim();
  var room = parseRoom_(roomRaw); // null for "Any suitable room"
  var moveIn = requireDate_(p.moveIn, 'Move-in');
  var moveOut = requireDate_(p.moveOut, 'Move-out');
  var nights = nightsBetween_(moveIn, moveOut);
  if (nights < MIN_NIGHTS) {
    throw new Error('Minimum stay is ' + MIN_NIGHTS + ' nights.');
  }
  if (moveIn < todayKey_()) {
    throw new Error('Move-in date is in the past.');
  }
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim();
  if (!name) throw new Error('Name is required.');
  if (!email || email.indexOf('@') < 0) throw new Error('A valid email is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var bookings = readBookings_();
    if (room) {
      var clash = findOverlap_(bookings, room, moveIn, moveOut, null);
      if (clash) {
        throw new Error('Those dates overlap an existing reservation for Room ' +
          room + ' (' + clash.bookingId + ', ' + clash.moveIn + ' to ' +
          clash.moveOut + '). Please choose other dates.');
      }
    }
    var bookingId = String(p.bookingId || '').trim() || newBookingId_(room);
    if (findBookingRow_(bookings, bookingId)) bookingId = newBookingId_(room);
    var row = buildBookingRow_({
      submitted: new Date(), bookingId: bookingId, status: 'Pending',
      room: room ? String(room) : roomRaw, moveIn: moveIn, moveOut: moveOut,
      nights: nights, name: name, email: email,
      guestType: String(p.guestType || ''), contactPreference: String(p.contactStyle || ''),
      bike: String(p.bike || ''), paymentPreference: String(p.paymentChoice || ''),
      paymentMethod: String(p.paymentMethod || ''),
      notes: String(p.message || ''), source: 'website'
    });
    appendBookingRow_(row);
    // Outbound calendar sync is best-effort only: a Pending request
    // creates no calendar block, so there is nothing to sync yet.
    sendMailSafe_(JAG_EMAIL + ',' + ROB_EMAIL,
      'New booking request ' + bookingId + ' — Ravi\u2019s Student Guest House',
      'New booking request (Pending — not a hold):\n' +
      'Booking ID: ' + bookingId + '\nRoom: ' + (room ? 'Room ' + room : roomRaw) +
      '\nDates: ' + moveIn + ' to ' + moveOut + ' (' + nights + ' nights)\n' +
      'Guest: ' + name + ' <' + email + '>\n' +
      'Guest type: ' + (p.guestType || '') + '\nContact preference: ' + (p.contactStyle || '') +
      '\nBike: ' + (p.bike || '') + '\nPayment preference: ' + (p.paymentChoice || '') +
      '\nPayment method: ' + (p.paymentMethod || '') + '\nMessage: ' + (p.message || ''));
    sendMailSafe_(email,
      'Your stay request ' + bookingId + ' — Ravi\u2019s Student Guest House',
      'Thank you, ' + name + '.\nYour stay request (' + bookingId + ') for ' +
      (room ? 'Room ' + room : roomRaw) + ', ' + moveIn + ' to ' + moveOut +
      ' (' + nights + ' nights) was received and is Pending. ' +
      'Ravi will personally confirm availability and final pricing. ' +
      'Please do not pay before confirmation.');
    return { ok: true, bookingId: bookingId, status: 'Pending',
      message: 'Request received. Ravi will confirm availability.' };
  } finally {
    lock.releaseLock();
  }
}

function submitReview_(p) {
  var rating = Number(p.rating);
  if (!(rating >= 1 && rating <= 5)) throw new Error('Rating must be 1–5.');
  var name = String(p.name || '').trim();
  var email = String(p.email || '').trim();
  var review = String(p.review || '').trim();
  if (!name) throw new Error('Name is required.');
  if (!email || email.indexOf('@') < 0) throw new Error('A valid email is required.');
  if (!review) throw new Error('Review text is required.');
  var reviewId = String(p.reviewId || '').trim() || newReviewId_();
  var row = buildReviewRow_({
    submitted: new Date(), reviewId: reviewId, status: 'Pending approval',
    name: name, email: email, room: String(p.room || ''),
    rating: rating, stayFrom: String(p.stayFrom || ''),
    stayTo: String(p.stayTo || ''), attribution: String(p.displayName || ''),
    review: review, source: 'website'
  });
  appendReviewRow_(row);
  sendMailSafe_(JAG_EMAIL + ',' + ROB_EMAIL,
    'New guest review ' + reviewId + ' — Ravi\u2019s Student Guest House',
    'A guest review was submitted for approval (not published):\n' +
    'Review ID: ' + reviewId + '\nGuest: ' + name + ' <' + email + '>\n' +
    'Room: ' + (p.room || '') + ' · Rating: ' + rating + '/5\n' +
    'Attribution choice: ' + (p.displayName || '') + '\n\n' + review);
  return { ok: true, reviewId: reviewId, status: 'Pending approval' };
}

// ---------------------------------------------------------------------------
// Quote (must match live v5 exactly — see tests)
// ---------------------------------------------------------------------------

function computeQuote_(roomRaw, moveInRaw, moveOutRaw, paymentMethod) {
  var room = parseRoom_(roomRaw);
  if (!room) throw new Error('Choose a specific room for a quote.');
  var pricing = getPricing_();
  var rates = getRates_();
  var monthlyRate = Number(rates[String(room)]);
  if (!monthlyRate) throw new Error('No rate is set for Room ' + room + '.');
  var moveIn = requireDate_(moveInRaw, 'Move-in');
  var moveOut = requireDate_(moveOutRaw, 'Move-out');
  var nights = nightsBetween_(moveIn, moveOut);
  if (nights < MIN_NIGHTS) {
    throw new Error('Minimum stay is ' + MIN_NIGHTS + ' nights.');
  }
  var subtotal = round2_(monthlyRate * nights / pricing.daysPerMonth);
  var cleaningFee = pricing.cleaningFee;
  var securityDeposit = pricing.securityDeposit;
  var feeBase = pricing.feeOnDeposit
    ? subtotal + cleaningFee + securityDeposit
    : subtotal + cleaningFee;
  var feeWaived = isFeeWaived_(paymentMethod, pricing.feeWaivedMethods);
  var transactionFee = feeWaived ? 0 : round2_(feeBase * pricing.transactionFeePercent / 100);
  var total = round2_(subtotal + cleaningFee + securityDeposit + transactionFee);
  return { room: room, monthlyRate: monthlyRate, daysPerMonth: pricing.daysPerMonth,
    nights: nights, moveIn: moveIn, moveOut: moveOut, subtotal: subtotal,
    cleaningFee: cleaningFee, securityDeposit: securityDeposit,
    transactionFee: transactionFee, feeWaived: feeWaived,
    paymentMethod: String(paymentMethod || ''),
    taxPercent: pricing.taxPercent, tax: 0, total: total,
    reservationPayment: pricing.reservationPayment,
    balanceAfterReservation: round2_(total - pricing.reservationPayment) };
}

function isFeeWaived_(paymentMethod, waivedMethods) {
  var m = String(paymentMethod || '').toLowerCase();
  if (!m) return false;
  return (waivedMethods || []).some(function (w) {
    return m.indexOf(String(w).toLowerCase()) >= 0;
  });
}

// ---------------------------------------------------------------------------
// Admin (google.script.run) — all behind requireAdmin_
// ---------------------------------------------------------------------------

/** Google identity first: EXACT match on rob@controllattice.com only.
 *  (v5 adminIdentity_ rule, preserved. Jag uses the password flow.
 *  Do NOT add Jag's Google address here until it is verified that
 *  Session.getActiveUser() returns Jag under the Execute-as-me
 *  deployment — see README / NATIVE_CALENDAR_DESIGN.md.) */
function adminIdentity_() {
  try {
    var email = Session.getActiveUser().getEmail();
    if (email && String(email).toLowerCase() === ADMIN_GOOGLE_EMAIL) {
      return { actor: String(email).toLowerCase(), method: 'google' };
    }
  } catch (err) { /* getActiveUser may be unavailable; fall through */ }
  return null;
}

function requireAdmin_(token) {
  var identity = adminIdentity_();
  if (identity) return identity;
  if (token) {
    var data = validateToken_(String(token));
    if (data) return { actor: data.actor || 'password-admin', method: 'password' };
  }
  throw new Error('Administrator sign-in required. Rob can open this page ' +
    'while signed in to rob@controllattice.com; Ravi signs in with his ' +
    'username (rgh.cleveland@gmail.com) and the administrator password.');
}

/** Username + password sign-in for Jag. Username is his Google address,
 *  rgh.cleveland@gmail.com (case-insensitive). A wrong username fails exactly
 *  like a wrong password, and counts toward the same lockout, so the
 *  error never says which one was wrong.
 *  Backward compat: adminLogin(password) with one argument still works
 *  as a password-only login (the v5 dashboard had no username field). */
function adminLogin(username, password) {
  if (password === undefined) {
    password = username;
    username = null;
  }
  var cache = CacheService.getScriptCache();
  var lockedUntil = Number(cache.get('admin-login-locked-until-v2') || 0);
  if (lockedUntil && Date.now() < lockedUntil) {
    throw new Error('Too many failed sign-in attempts. Please try again later.');
  }
  function failLogin_() {
    var attempts = Number(cache.get('admin-login-attempts-v2') || 0) + 1;
    cache.put('admin-login-attempts-v2', String(attempts), LOGIN_LOCK_SECONDS);
    if (attempts >= LOGIN_MAX_ATTEMPTS) {
      cache.put('admin-login-locked-until-v2',
        String(Date.now() + LOGIN_LOCK_SECONDS * 1000), LOGIN_LOCK_SECONDS);
      cache.remove('admin-login-attempts-v2');
      throw new Error('Too many failed sign-in attempts. Please try again later.');
    }
    throw new Error('Incorrect username or password.');
  }
  if (username !== null && username !== undefined &&
      String(username).toLowerCase().trim() !== ADMIN_USERNAME) {
    failLogin_();
  }
  var props = PropertiesService.getScriptProperties();
  var hash = props.getProperty('ADMIN_PASSWORD_HASH');
  var salt = props.getProperty('ADMIN_PASSWORD_SALT');
  if (!hash || !salt) {
    throw new Error('No administrator password is set yet. Rob must set one ' +
      'while signed in to rob@controllattice.com.');
  }
  if (hashPassword_(String(password || ''), salt) !== hash) {
    failLogin_();
  }
  cache.remove('admin-login-attempts-v2');
  var token = newToken_();
  cache.put('admin-token-' + token, JSON.stringify({
    actor: ADMIN_USERNAME,
    sessionVersion: props.getProperty('ADMIN_SESSION_VERSION') || '1'
  }), TOKEN_TTL_SECONDS);
  return { ok: true, token: token };
}

/** Personal-link sign-in for Ravi (owner.html?k=<secret>): no typing,
 *  no Google account — the secret in his private link IS the credential.
 *  The secret lives ONLY in the ADMIN_LINK_SECRET script property and in
 *  the link Ravi keeps; it is never written into code (the repo is
 *  public). Run setupLinkSecret() once from the editor to create it.
 *  This flow has its OWN lockout (link-login-*-v1 cache keys), separate
 *  from the password lockout; clearLoginLockout_() clears both. On
 *  success it issues exactly the same token adminLogin issues. */
function adminLinkLogin(secret) {
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty('ADMIN_LINK_SECRET');
  if (!stored) {
    throw new Error('Personal link sign-in is not set up yet.');
  }
  var cache = CacheService.getScriptCache();
  var lockedUntil = Number(cache.get('link-login-locked-until-v1') || 0);
  if (lockedUntil && Date.now() < lockedUntil) {
    throw new Error('Too many failed sign-in attempts. Please try again later.');
  }
  function failLinkLogin_() {
    var attempts = Number(cache.get('link-login-attempts-v1') || 0) + 1;
    cache.put('link-login-attempts-v1', String(attempts), LINK_LOGIN_LOCK_SECONDS);
    if (attempts >= LINK_LOGIN_MAX_ATTEMPTS) {
      cache.put('link-login-locked-until-v1',
        String(Date.now() + LINK_LOGIN_LOCK_SECONDS * 1000), LINK_LOGIN_LOCK_SECONDS);
      cache.remove('link-login-attempts-v1');
      throw new Error('Too many failed sign-in attempts. Please try again later.');
    }
    throw new Error('This personal link is not valid.');
  }
  if (stored.length < 32 || String(secret || '') !== stored) {
    failLinkLogin_();
  }
  cache.remove('link-login-attempts-v1');
  var token = newToken_();
  cache.put('admin-token-' + token, JSON.stringify({
    actor: ADMIN_USERNAME,
    sessionVersion: props.getProperty('ADMIN_SESSION_VERSION') || '1'
  }), TOKEN_TTL_SECONDS);
  return { ok: true, token: token };
}

/** One-off setup for the personal-link sign-in: Rob runs this ONCE from
 *  the Apps Script editor to create the ADMIN_LINK_SECRET script
 *  property. The new secret is shown only in the editor log at creation
 *  time — copy it into Ravi's personal link (owner.html?k=<secret>)
 *  then. Idempotent: if a secret already exists it is left unchanged,
 *  and an existing secret is never logged or returned. */
function setupLinkSecret() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ADMIN_LINK_SECRET')) {
    Logger.log('ADMIN_LINK_SECRET already set; leaving it unchanged.');
    return;
  }
  var secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  props.setProperty('ADMIN_LINK_SECRET', secret);
  Logger.log('ADMIN_LINK_SECRET created: ' + secret);
}

function adminLogout(token) {
  if (token) {
    try { CacheService.getScriptCache().remove('admin-token-' + String(token)); } catch (err) {}
  }
  return { ok: true };
}

/** Clears the admin sign-in lockout and the failed-attempt counter
 *  (current v2 keys, plus the pre-v8 keys for safety), and the
 *  personal-link sign-in lockout keys as well, so Rob's reset also
 *  revives a locked personal link. */
function clearLoginLockout_() {
  var cache = CacheService.getScriptCache();
  cache.remove('admin-login-locked-until-v2');
  cache.remove('admin-login-attempts-v2');
  cache.remove('admin-login-locked-until');
  cache.remove('admin-login-attempts');
  cache.remove('link-login-locked-until-v1');
  cache.remove('link-login-attempts-v1');
}

/** Dashboard action: reset the sign-in lockout on demand. Caller must
 *  already be an admin (Rob's Google identity, or a valid admin token).
 *  Audited in the Admin Audit tab. */
function adminResetLoginLockout(token) {
  var admin = requireAdmin_(token);
  clearLoginLockout_();
  audit_(admin.actor, 'Clear admin login lockout', '');
  return { ok: true };
}

/** GET ?action=reset-lockout — Rob's on-demand reset link. Only Rob's
 *  Google identity (adminIdentity_) can clear the lockout this way;
 *  anyone else just gets an explanation, and nothing is cleared. */
function resetLockoutResponse_() {
  var identity = adminIdentity_();
  if (!identity) {
    return json_({ ok: false, error: 'Not cleared. Open this link while ' +
      'signed in to Google as rob@controllattice.com.' });
  }
  clearLoginLockout_();
  audit_(identity.actor, 'Clear admin login lockout (reset link)', '');
  return json_({ ok: true, cleared: true,
    message: 'Admin sign-in lockout cleared. Ravi can sign in now.' });
}

/** Requires an already-authorised admin. Min 14 chars. Stores salt +
 *  iterated SHA-256 digest only — never plaintext. Rotates the session
 *  version, which invalidates all existing password tokens. */
function adminSetPassword(token, newPassword) {
  var admin = requireAdmin_(token);
  var pw = String(newPassword || '');
  if (pw.length < 14) {
    throw new Error('Password must be at least 14 characters.');
  }
  var salt = Utilities.getUuid() + '-' + Utilities.getUuid();
  var props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_PASSWORD_SALT', salt);
  props.setProperty('ADMIN_PASSWORD_HASH', hashPassword_(pw, salt));
  var version = Number(props.getProperty('ADMIN_SESSION_VERSION') || '1') + 1;
  props.setProperty('ADMIN_SESSION_VERSION', String(version));
  audit_(admin.actor, 'Set administrator password', '');
  return { ok: true };
}

function adminData(token, month) {
  var admin = requireAdmin_(token);
  var bookings = readBookings_();
  var reviews = readReviews_();
  var rates = getRates_();
  var pricing = getPricing_();
  var monthKey = String(month || '').match(/^\d{4}-\d{2}$/)
    ? month : todayKey_().slice(0, 7);
  var monthStart = monthKey + '-01';
  var monthEnd = nextMonthKey_(monthKey) + '-01';
  var rooms = [];
  for (var id = 1; id <= 10; id++) {
    var events = blockingRanges_(bookings, id, monthStart, monthEnd)
      .map(function (r) {
        var b = bookings.filter(function (x) {
          return Number(x.room) === id && x.moveIn === r[0] && x.moveOut === r[1] &&
            BLOCKING_STATUSES.indexOf(x.status) >= 0;
        })[0];
        return { start: r[0], end: r[1],
          title: b ? (b.status + ' — ' + b.name) : 'Blocked' };
      });
    rooms.push({ id: id, rate: rates[String(id)], connected: true,
      source: 'native', calendarConfigured: !!getCalendarId_(id),
      events: events });
  }
  return { actor: admin.actor, rooms: rooms,
    bookings: bookings.map(bookingToRow_),
    reviews: reviews.map(reviewToRow_),
    pricing: pricing,
    passwordConfigured: !!PropertiesService.getScriptProperties()
      .getProperty('ADMIN_PASSWORD_HASH'),
    syncPending: getSyncPending_() };
}

function adminSaveRate(token, room, rate) {
  var admin = requireAdmin_(token);
  var id = parseRoom_(room);
  if (!id) throw new Error('Room must be 1–10.');
  var value = Number(rate);
  if (!(value > 0)) throw new Error('Rate must be greater than 0.');
  var rates = getRates_();
  rates[String(id)] = value;
  saveRates_(rates);
  audit_(admin.actor, 'Set Room ' + id + ' rate to $' + value, 'Room ' + id);
  return { ok: true, rates: rates };
}

function adminSaveBooking(token, booking) {
  var admin = requireAdmin_(token);
  booking = booking || {};
  var room = parseRoom_(booking.room);
  var moveIn = requireDate_(booking.moveIn, 'Move-in');
  var moveOut = requireDate_(booking.moveOut, 'Move-out');
  var nights = nightsBetween_(moveIn, moveOut);
  if (nights < MIN_NIGHTS) {
    throw new Error('Minimum stay is ' + MIN_NIGHTS + ' nights.');
  }
  var status = String(booking.status || 'Pending');
  if (['Pending', 'Confirmed', 'Denied', 'Cancelled', 'Maintenance'].indexOf(status) < 0) {
    throw new Error('Unknown status: ' + status);
  }
  var name = String(booking.name || booking.guest || '').trim();
  if (!name) throw new Error('Guest name or block description is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var bookings = readBookings_();
    var id = String(booking.id || '').trim();
    var existing = id ? findBookingRow_(bookings, id) : null;
    if (room && (status === 'Confirmed' || status === 'Maintenance')) {
      var clash = findOverlap_(bookings, room, moveIn, moveOut, id || null);
      if (clash) {
        throw new Error('Those dates overlap an existing reservation for Room ' +
          room + ' (' + clash.bookingId + ', ' + clash.moveIn + ' to ' +
          clash.moveOut + ').');
      }
    }
    var bookingId, row;
    if (existing) {
      bookingId = existing.bookingId;
      row = buildBookingRow_({
        submitted: existing.submitted, bookingId: bookingId, status: status,
        room: room ? String(room) : existing.room, moveIn: moveIn,
        moveOut: moveOut, nights: nights, name: name,
        email: String(booking.email || existing.email || ''),
        guestType: existing.guestType, contactPreference: existing.contactPreference,
        bike: existing.bike, paymentPreference: existing.paymentPreference,
        paymentMethod: String(booking.paymentMethod || existing.paymentMethod || ''),
        notes: String(booking.notes != null ? booking.notes : existing.notes || ''),
        source: existing.source || 'admin'
      });
      updateBookingRow_(existing.rowIndex, row);
    } else {
      bookingId = id || newBookingId_(room);
      row = buildBookingRow_({
        submitted: new Date(), bookingId: bookingId, status: status,
        room: room ? String(room) : String(booking.room || ''), moveIn: moveIn,
        moveOut: moveOut, nights: nights, name: name,
        email: String(booking.email || ''),
        guestType: '', contactPreference: '', bike: '',
        paymentPreference: '', paymentMethod: String(booking.paymentMethod || ''),
        notes: String(booking.notes || ''), source: 'admin'
      });
      appendBookingRow_(row);
    }
    audit_(admin.actor, 'Saved booking ' + bookingId + ' (' + status + ')', bookingId);
    // Outbound sync AFTER the sheet commit. A calendar failure must
    // never roll back the native reservation.
    var sync = null;
    if (status === 'Confirmed' || status === 'Maintenance') {
      sync = syncBookingToCalendar_({ bookingId: bookingId, room: room,
        moveIn: moveIn, moveOut: moveOut, name: name, status: status });
    } else {
      sync = deleteCalendarEvent_(bookingId);
    }
    return { ok: true, bookingId: bookingId, sync: sync };
  } finally {
    lock.releaseLock();
  }
}

function adminModerateReview(token, reviewId, status) {
  var admin = requireAdmin_(token);
  var allowed = ['Approved', 'Declined', 'Pending approval'];
  if (allowed.indexOf(String(status)) < 0) {
    throw new Error('Unknown review status: ' + status);
  }
  var reviews = readReviews_();
  var found = null;
  reviews.forEach(function (r) {
    if (String(r.reviewId) === String(reviewId)) found = r;
  });
  if (!found) throw new Error('Review not found: ' + reviewId);
  var row = buildReviewRow_(found);
  row[2] = status;
  updateReviewRow_(found.rowIndex, row);
  audit_(admin.actor, 'Review ' + reviewId + ' -> ' + status, String(reviewId));
  return { ok: true, reviewId: String(reviewId), status: String(status) };
}

function adminSavePricing(token, pricing) {
  var admin = requireAdmin_(token);
  pricing = pricing || {};
  var current = getPricing_();
  var next = {
    cleaningFee: numOr_(pricing.cleaningFee, current.cleaningFee),
    securityDeposit: numOr_(pricing.securityDeposit, current.securityDeposit),
    transactionFeePercent: numOr_(pricing.transactionFeePercent, current.transactionFeePercent),
    reservationPayment: numOr_(pricing.reservationPayment, current.reservationPayment),
    taxPercent: numOr_(pricing.taxPercent, current.taxPercent),
    daysPerMonth: pricing.daysPerMonth === 31 || pricing.daysPerMonth === '31' ? 31 : 30,
    feeOnDeposit: pricing.feeOnDeposit != null ? !!pricing.feeOnDeposit : current.feeOnDeposit,
    feeWaivedMethods: current.feeWaivedMethods
  };
  savePricing_(next);
  audit_(admin.actor, 'Saved pricing (billing days ' + next.daysPerMonth + ')', '');
  return { ok: true, pricing: next };
}

function adminQuote(token, q) {
  requireAdmin_(token);
  q = q || {};
  return computeQuote_(q.room, q.moveIn, q.moveOut, q.paymentMethod);
}

// ---------------------------------------------------------------------------
// Admin JSON API (for the site-hosted admin page, admin.html)
// ---------------------------------------------------------------------------

/**
 * JSON transport to the SAME admin functions the Apps Script dashboard
 * calls via google.script.run. It exists because Google serves the
 * ?action=admin page unreliably for browsers signed into multiple /
 * other Google accounts ("Sorry, unable to open the file at this
 * time"), while the static site (ravisguesthouse.com) loads for anyone.
 * admin.html on the site POSTs form fields — the same URLSearchParams
 * transport the public booking form uses (a CORS-simple request, no
 * preflight):
 *   action = 'admin-api'
 *   fn     = one of the whitelisted admin function names below
 *   args   = JSON array of arguments, in the function's normal order
 * and reads back { ok:true, result } or { ok:false, error }.
 *
 * SECURITY: this dispatcher adds NO authorisation of its own and must
 * never gain any. Every whitelisted function except adminLogin and
 * adminLinkLogin takes the admin token as its first argument and
 * enforces it through requireAdmin_ / validateToken_, exactly as the
 * google.script.run path does; adminLogin is the existing username +
 * password sign-in (with its lockout), and adminLinkLogin is the
 * personal-link sign-in (the secret in Ravi's private owner.html link,
 * with its own separate lockout). Only the functions the dashboard
 * itself calls are whitelisted — anything else is rejected as unknown,
 * so no other server function (setupBackend, setupLinkSecret, the
 * import, helpers) is reachable through this route.
 *
 * SERIALIZATION: results go out through json_ (JSON.stringify), so a
 * Date anywhere in a result becomes an ISO string, never a raw Date —
 * the same guarantee the v10 dateTimeCell_ fix gives the
 * google.script.run transport.
 */
function adminApiResponse_(p) {
  var dispatch = {
    adminLogin: adminLogin,
    adminLinkLogin: adminLinkLogin,
    adminLogout: adminLogout,
    adminData: adminData,
    adminSaveRate: adminSaveRate,
    adminSaveBooking: adminSaveBooking,
    adminModerateReview: adminModerateReview,
    adminSavePricing: adminSavePricing,
    adminQuote: adminQuote,
    adminSetPassword: adminSetPassword,
    adminResetLoginLockout: adminResetLoginLockout
  };
  var fnName = String(p.fn || '');
  var fn = dispatch[fnName];
  if (!fn) {
    return { ok: false, error: 'Unknown admin function: ' + fnName };
  }
  var args;
  try {
    args = JSON.parse(String(p.args || '[]'));
  } catch (err) {
    return { ok: false, error: 'Invalid args: expected a JSON array.' };
  }
  if (!Array.isArray(args)) {
    return { ok: false, error: 'Invalid args: expected a JSON array.' };
  }
  try {
    var result = fn.apply(null, args);
    return { ok: true, result: result === undefined ? null : result };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

/**
 * One-off carry-forward of Calendar-only reservations / maintenance
 * blocks into the native sheet. NEVER runs automatically — an admin
 * calls it explicitly, ideally with dryRun:true first.
 * Entries marked free, or titled "Available", are NOT imported; they
 * are returned in skippedFree for Jag to review. Duplicates (same
 * room + dates already in the sheet, or an existing BOOKING_EVENT_
 * mapping) are skipped. Imported rows are Confirmed, Source =
 * "google-calendar-import".
 * TRANSPARENCY WARNING — do not treat every calendar event as a
 * block. Google Calendar "free" events have transparency
 * "transparent" (CalendarApp.EventTransparency.FREE), not the word
 * "free". Verified example (Nov 11 2026): Room 1 has a single event
 * in the Nov 2026–Jan 2027 window, "Room 1 - Shashwat Shrivastava",
 * 2026-05-01 to 2027-06-01, creator jrslmgt@gmail.com, transparency
 * transparent. That 13-month span is the same range the old frontend
 * hardcoded as Room 1's blocked snapshot — yet as a transparent
 * event it does NOT block time in Google terms. It may be a
 * long-term stay recorded as a marker, or it may not be a booking
 * at all. Either way it must be surfaced to Jag, never auto-imported
 * as a block. The import therefore treats an event as free when its
 * transparency is FREE / "free" / "transparent", or its title
 * contains "Available", and lists it in skippedFree with its
 * creator when available.
 * PREREQUISITE: the import runs as the executing account (rob@ under
 * Execute-as-me). That account must be able to READ each room
 * calendar — currently rob@ cannot see Rooms 1–10 at all, so an
 * import today would report an error per room. Before importing, Jag
 * must share the room calendars with rob@controllattice.com (reader
 * access is enough for the import; edit access is needed only for
 * outbound sync). The dry run will show this clearly in `errors`.
 */
function adminImportCalendarEvents(token, options) {
  var admin = requireAdmin_(token);
  options = options || {};
  var dryRun = !!options.dryRun;
  var monthsAhead = Number(options.monthsAhead || 12);
  var now = new Date();
  var horizon = new Date(now.getFullYear(), now.getMonth() + monthsAhead, now.getDate());
  var bookings = readBookings_();
  var props = PropertiesService.getScriptProperties();
  var summary = { ok: true, dryRun: dryRun, imported: 0, wouldImport: 0,
    skippedDuplicates: 0, skippedFree: [], skippedNoCalendar: 0, errors: [] };
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    for (var id = 1; id <= 10; id++) {
      var calendarId = getCalendarId_(id);
      if (!calendarId) { summary.skippedNoCalendar++; continue; }
      var events;
      try {
        var cal = CalendarApp.getCalendarById(calendarId);
        if (!cal) throw new Error('Calendar not found: ' + calendarId);
        events = cal.getEvents(now, horizon);
      } catch (err) {
        summary.errors.push('Room ' + id + ': ' + String(err && err.message || err));
        continue;
      }
      events.forEach(function (ev) {
        try {
          var title = String(ev.getTitle() || '').trim();
          // Google "free" transparency is "transparent" (EventTransparency.FREE),
          // not the word "free" — check both spellings and the enum itself.
          var transparency = '';
          var transparencyIsFree = false;
          try {
            var t = ev.getTransparency();
            transparency = String(t || '');
            transparencyIsFree = (t === CalendarApp.EventTransparency.FREE) ||
              /free|transparent/i.test(transparency);
          } catch (e2) {}
          if (transparencyIsFree || /available/i.test(title)) {
            var creator = '';
            try {
              var creators = ev.getCreators ? ev.getCreators() : [];
              creator = creators && creators.length ? String(creators[0]) : '';
            } catch (e3) {}
            summary.skippedFree.push({ room: id, title: title,
              start: formatDateKey_(ev.getStartTime()),
              end: formatDateKey_(ev.getEndTime()),
              transparency: transparency, creator: creator });
            return;
          }
          // Guest name: strip a "Room N - " prefix from the event title
          // ("Room 1 - Shashwat Shrivastava" -> "Shashwat Shrivastava").
          var guestName = title.replace(/^\s*Room\s+\d+\s*[-–—:]\s*/i, '') || title;
          var moveIn = formatDateKey_(ev.getStartTime());
          var moveOut = formatDateKey_(ev.getEndTime());
          if (nightsBetween_(moveIn, moveOut) < 1) return;
          var duplicate = bookings.some(function (b) {
            return Number(b.room) === id && b.moveIn === moveIn &&
              b.moveOut === moveOut &&
              BLOCKING_STATUSES.indexOf(b.status) >= 0;
          });
          if (duplicate) { summary.skippedDuplicates++; return; }
          if (dryRun) { summary.wouldImport++; return; }
          var bookingId = newBookingId_(id);
          var row = buildBookingRow_({
            submitted: new Date(), bookingId: bookingId, status: 'Confirmed',
            room: String(id), moveIn: moveIn, moveOut: moveOut,
            nights: nightsBetween_(moveIn, moveOut), name: guestName || 'Calendar reservation',
            email: '', guestType: '', contactPreference: '', bike: '',
            paymentPreference: '', paymentMethod: '', notes: 'Imported from Google Calendar.',
            source: 'google-calendar-import'
          });
          appendBookingRow_(row);
          bookings.push(rowToBooking_(row, bookings.length + 2));
          props.setProperty('BOOKING_EVENT_' + bookingId,
            calendarId + '|' + String(ev.getId()));
          summary.imported++;
        } catch (err) {
          summary.errors.push('Room ' + id + ': ' + String(err && err.message || err));
        }
      });
    }
    audit_(admin.actor, 'Imported calendar events' + (dryRun ? ' (dry run)' : '') +
      ': ' + (dryRun ? summary.wouldImport : summary.imported) + ' imported', '');
    return summary;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// setupBackend — SAFE version: never creates a spreadsheet
// ---------------------------------------------------------------------------

function setupBackend() {
  var warnings = [];
  var created = [];
  var spreadsheet = null;
  var spreadsheetId = null;
  try {
    spreadsheet = getSpreadsheet_();
    spreadsheetId = spreadsheet.getId ? spreadsheet.getId() : null;
  } catch (err) {
    return { ok: false,
      error: 'Booking spreadsheet is not configured. ' +
        'Set script property BOOKING_SPREADSHEET_ID to the ID of ' +
        '"Ravi Guest House Booking Requests" (Rob can find it in the ' +
        'Apps Script project settings), then run setupBackend again. ' +
        'No spreadsheet was created. Details: ' + String(err && err.message || err) };
  }
  var sheets = {
    'Booking Requests': BOOKING_HEADERS,
    'Review Submissions': REVIEW_HEADERS,
    'Admin Audit': AUDIT_HEADERS
  };
  Object.keys(sheets).forEach(function (name) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(name);
      sheet.getRange(1, 1, 1, sheets[name].length).setValues([sheets[name]]);
      created.push(name);
    } else {
      var header = sheet.getRange(1, 1, 1, sheets[name].length).getValues()[0]
        .map(function (h) { return String(h || '').trim(); });
      sheets[name].forEach(function (expected, i) {
        if (header[i] !== expected) {
          warnings.push('Sheet "' + name + '" column ' + (i + 1) + ' is "' +
            (header[i] || '') + '", expected "' + expected +
            '". Existing data was NOT changed — verify before deploying.');
        }
      });
    }
  });
  var props = PropertiesService.getScriptProperties();
  var ratesSeeded = false;
  if (!props.getProperty('ROOM_RATES')) {
    props.setProperty('ROOM_RATES', JSON.stringify(DEFAULT_RATES));
    ratesSeeded = true;
  }
  if (!props.getProperty('BILLING_DAYS')) {
    props.setProperty('BILLING_DAYS', '30');
  }
  return { ok: true, spreadsheetId: spreadsheetId, created: created,
    ratesSeeded: ratesSeeded, warnings: warnings,
    note: 'Verify the header warnings (if any) against the live sheet ' +
      'before deploying. setupBackend never overwrites existing data.' };
}

// ---------------------------------------------------------------------------
// Sheets access — header-mapped, positional fallback to the exact schema
// ---------------------------------------------------------------------------

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BOOKING_SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (err) { active = null; }
  if (active) return active;
  throw new Error('BOOKING_SPREADSHEET_ID script property is not set and ' +
    'there is no active spreadsheet. Set the property to the ID of ' +
    '"Ravi Guest House Booking Requests".');
}

function getSheet_(name) {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" was not found in the ' +
    'booking spreadsheet. Run setupBackend to create it.');
  return sheet;
}

function colIndex_(headers, wanted, fallback) {
  var norm = function (s) { return String(s || '').trim().toLowerCase(); };
  for (var i = 0; i < headers.length; i++) {
    if (norm(headers[i]) === norm(wanted)) return i;
  }
  return fallback; // exact A–P / A–L positional layout
}

function readSheetRows_(name, headers) {
  var sheet = getSheet_(name);
  var values = sheet.getDataRange().getValues();
  if (!values.length) return [];
  var headerRow = values[0].map(function (h) { return String(h == null ? '' : h); });
  var idx = {};
  headers.forEach(function (h, i) { idx[h] = colIndex_(headerRow, h, i); });
  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var v = values[r];
    if (v.every(function (c) { return c === '' || c == null; })) continue;
    rows.push({ values: v, rowIndex: r + 1, idx: idx });
  }
  return rows;
}

function readBookings_() {
  return readSheetRows_('Booking Requests', BOOKING_HEADERS).map(function (r) {
    return rowToBooking_(r.values, r.rowIndex);
  });
}

function rowToBooking_(v, rowIndex) {
  var s = function (i) { return v[i] == null ? '' : String(v[i]); };
  return { submitted: dateTimeCell_(v[0]), bookingId: s(1), status: s(2), room: s(3),
    moveIn: dateCell_(v[4]), moveOut: dateCell_(v[5]), nights: Number(v[6]) || 0,
    name: s(7), email: s(8), guestType: s(9), contactPreference: s(10),
    bike: s(11), paymentPreference: s(12), paymentMethod: s(13),
    notes: s(14), source: s(15), rowIndex: rowIndex };
}

function bookingToRow_(b) {
  return [b.submitted, b.bookingId, b.status, b.room, b.moveIn, b.moveOut,
    b.nights, b.name, b.email, b.guestType, b.contactPreference, b.bike,
    b.paymentPreference, b.paymentMethod, b.notes, b.source];
}

function buildBookingRow_(b) {
  return { submitted: b.submitted, bookingId: b.bookingId, status: b.status,
    room: b.room, moveIn: b.moveIn, moveOut: b.moveOut, nights: b.nights,
    name: b.name, email: b.email, guestType: b.guestType,
    contactPreference: b.contactPreference, bike: b.bike,
    paymentPreference: b.paymentPreference, paymentMethod: b.paymentMethod,
    notes: b.notes, source: b.source };
}

function appendBookingRow_(row) {
  getSheet_('Booking Requests').appendRow(bookingToRow_(row));
}

function updateBookingRow_(rowIndex, row) {
  getSheet_('Booking Requests').getRange(rowIndex, 1, 1, BOOKING_HEADERS.length)
    .setValues([bookingToRow_(row)]);
}

function findBookingRow_(bookings, bookingId) {
  var found = null;
  bookings.forEach(function (b) {
    if (String(b.bookingId) === String(bookingId)) found = b;
  });
  return found;
}

function readReviews_() {
  return readSheetRows_('Review Submissions', REVIEW_HEADERS).map(function (r) {
    return rowToReview_(r.values, r.rowIndex);
  });
}

function rowToReview_(v, rowIndex) {
  var s = function (i) { return v[i] == null ? '' : String(v[i]); };
  return { submitted: dateTimeCell_(v[0]), reviewId: s(1), status: s(2), name: s(3),
    email: s(4), room: s(5), rating: s(6), stayFrom: s(7), stayTo: s(8),
    attribution: s(9), review: s(10), source: s(11), rowIndex: rowIndex };
}

function reviewToRow_(r) {
  return [r.submitted, r.reviewId, r.status, r.name, r.email, r.room,
    r.rating, r.stayFrom, r.stayTo, r.attribution, r.review, r.source];
}

function buildReviewRow_(r) {
  return { submitted: r.submitted, reviewId: r.reviewId, status: r.status,
    name: r.name, email: r.email, room: r.room, rating: r.rating,
    stayFrom: r.stayFrom, stayTo: r.stayTo, attribution: r.attribution,
    review: r.review, source: r.source };
}

function appendReviewRow_(row) {
  getSheet_('Review Submissions').appendRow(reviewToRow_(row));
}

function updateReviewRow_(rowIndex, row) {
  getSheet_('Review Submissions').getRange(rowIndex, 1, 1, REVIEW_HEADERS.length)
    .setValues([reviewToRow_(row)]);
}

function audit_(actor, action, reference) {
  try {
    var sheet = getSheet_('Admin Audit');
    sheet.appendRow([new Date(), actor, action, reference || '']);
  } catch (err) { /* Audit must never break an admin action. */ }
}

// ---------------------------------------------------------------------------
// Rates / pricing (script properties, not Sheets)
// ---------------------------------------------------------------------------

function getRates_() {
  var props = PropertiesService.getScriptProperties();
  try {
    var parsed = JSON.parse(props.getProperty('ROOM_RATES') || '{}');
    var rates = {};
    for (var id = 1; id <= 10; id++) {
      var v = Number(parsed[String(id)]);
      rates[String(id)] = v > 0 ? v : DEFAULT_RATES[String(id)];
    }
    return rates;
  } catch (err) {
    return JSON.parse(JSON.stringify(DEFAULT_RATES));
  }
}

function saveRates_(rates) {
  PropertiesService.getScriptProperties()
    .setProperty('ROOM_RATES', JSON.stringify(rates));
}

function getPricing_() {
  var props = PropertiesService.getScriptProperties();
  var overrides = {};
  try { overrides = JSON.parse(props.getProperty('PRICING_OVERRIDES') || '{}'); } catch (err) {}
  var days = Number(props.getProperty('BILLING_DAYS') || DEFAULT_PRICING.daysPerMonth);
  return {
    cleaningFee: numOr_(overrides.cleaningFee, DEFAULT_PRICING.cleaningFee),
    securityDeposit: numOr_(overrides.securityDeposit, DEFAULT_PRICING.securityDeposit),
    transactionFeePercent: numOr_(overrides.transactionFeePercent, DEFAULT_PRICING.transactionFeePercent),
    reservationPayment: numOr_(overrides.reservationPayment, DEFAULT_PRICING.reservationPayment),
    taxPercent: numOr_(overrides.taxPercent, DEFAULT_PRICING.taxPercent),
    daysPerMonth: days === 31 ? 31 : 30,
    feeOnDeposit: overrides.feeOnDeposit != null ? !!overrides.feeOnDeposit : true,
    feeWaivedMethods: DEFAULT_PRICING.feeWaivedMethods.slice()
  };
}

function savePricing_(pricing) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('BILLING_DAYS', String(pricing.daysPerMonth));
  props.setProperty('PRICING_OVERRIDES', JSON.stringify({
    cleaningFee: pricing.cleaningFee,
    securityDeposit: pricing.securityDeposit,
    transactionFeePercent: pricing.transactionFeePercent,
    reservationPayment: pricing.reservationPayment,
    taxPercent: pricing.taxPercent,
    feeOnDeposit: pricing.feeOnDeposit
  }));
}

// ---------------------------------------------------------------------------
// Availability helpers (native)
// ---------------------------------------------------------------------------

function blockingRanges_(bookings, roomId, start, end) {
  var ranges = [];
  bookings.forEach(function (b) {
    if (Number(b.room) !== Number(roomId)) return;
    if (BLOCKING_STATUSES.indexOf(String(b.status)) < 0) return;
    if (!b.moveIn || !b.moveOut) return;
    if (b.moveIn < end && b.moveOut > start) {
      ranges.push([b.moveIn, b.moveOut]);
    }
  });
  ranges.sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  return ranges;
}

function findOverlap_(bookings, roomId, moveIn, moveOut, excludeBookingId) {
  var found = null;
  bookings.forEach(function (b) {
    if (found) return;
    if (Number(b.room) !== Number(roomId)) return;
    if (BLOCKING_STATUSES.indexOf(String(b.status)) < 0) return;
    if (excludeBookingId && String(b.bookingId) === String(excludeBookingId)) return;
    if (b.moveIn < moveOut && b.moveOut > moveIn) found = b;
  });
  return found;
}

function overlapsAny_(ranges, start, end) {
  return ranges.some(function (r) { return r[0] < end && r[1] > start; });
}

// ---------------------------------------------------------------------------
// Google Calendar — optional outbound sync only (never blocks anything)
// ---------------------------------------------------------------------------

function getCalendarId_(roomId) {
  try {
    return PropertiesService.getScriptProperties()
      .getProperty('CALENDAR_ROOM_' + roomId) || '';
  } catch (err) { return ''; }
}

/** Create/update the calendar event for a Confirmed/Maintenance booking.
 *  Returns {ok, eventId?, status, error?}. Never throws. */
function syncBookingToCalendar_(booking) {
  if (!booking.room) return { ok: true, status: 'no-room' };
  var calendarId = getCalendarId_(booking.room);
  if (!calendarId) return { ok: true, status: 'not-configured' };
  var props = PropertiesService.getScriptProperties();
  var key = 'BOOKING_EVENT_' + booking.bookingId;
  try {
    var cal = CalendarApp.getCalendarById(calendarId);
    if (!cal) throw new Error('Calendar not found: ' + calendarId);
    var title = 'Ravi\u2019s Guest House — Room ' + booking.room + ' — ' + booking.name;
    var start = parseDate_(booking.moveIn);
    var end = parseDate_(booking.moveOut);
    var mapping = props.getProperty(key) || '';
    var eventId = mapping.split('|')[1] || '';
    var event = null;
    if (eventId) {
      try { event = cal.getEventById(eventId); } catch (err) { event = null; }
    }
    if (event) {
      try { event.setTitle(title); } catch (err) {}
      try { event.setAllDayDates(start, end); } catch (err) {}
    } else {
      event = cal.createAllDayEvent(title, start, end);
      eventId = event.getId();
      props.setProperty(key, calendarId + '|' + eventId);
    }
    props.deleteProperty('SYNC_PENDING_' + booking.bookingId);
    return { ok: true, status: 'synced', eventId: eventId };
  } catch (err) {
    var message = String(err && err.message || err);
    props.setProperty('SYNC_PENDING_' + booking.bookingId, JSON.stringify({
      bookingId: booking.bookingId, room: booking.room,
      moveIn: booking.moveIn, moveOut: booking.moveOut, error: message
    }));
    return { ok: false, status: 'failed', error: message };
  }
}

/** Delete the calendar event for a booking that is no longer blocking.
 *  Never throws; a missing mapping or calendar is a no-op. */
function deleteCalendarEvent_(bookingId) {
  var props = PropertiesService.getScriptProperties();
  var key = 'BOOKING_EVENT_' + bookingId;
  var mapping = props.getProperty(key) || '';
  if (!mapping) return { ok: true, status: 'no-event' };
  var parts = mapping.split('|');
  try {
    var cal = CalendarApp.getCalendarById(parts[0]);
    if (cal && parts[1]) {
      var event = cal.getEventById(parts[1]);
      if (event) event.deleteEvent();
    }
    props.deleteProperty(key);
    props.deleteProperty('SYNC_PENDING_' + bookingId);
    return { ok: true, status: 'deleted' };
  } catch (err) {
    return { ok: false, status: 'failed', error: String(err && err.message || err) };
  }
}

function getSyncPending_() {
  var out = [];
  try {
    var all = PropertiesService.getScriptProperties().getProperties();
    Object.keys(all).forEach(function (k) {
      if (k.indexOf('SYNC_PENDING_') === 0) {
        try { out.push(JSON.parse(all[k])); } catch (err) {}
      }
    });
  } catch (err) {}
  return out;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function hashPassword_(password, salt) {
  var input = salt + ':' + password;
  var bytes = null;
  for (var i = 0; i < HASH_ITERATIONS; i++) {
    bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      input + ':' + i);
    input = bytesToHex_(bytes);
  }
  return bytesToHex_(bytes);
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var v = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    hex += ('0' + v.toString(16)).slice(-2);
  }
  return hex;
}

function newToken_() {
  return Utilities.getUuid() + '-' + Utilities.getUuid();
}

function validateToken_(token) {
  try {
    var raw = CacheService.getScriptCache().get('admin-token-' + token);
    if (!raw) return null;
    var data = JSON.parse(raw);
    var version = PropertiesService.getScriptProperties()
      .getProperty('ADMIN_SESSION_VERSION') || '1';
    if (String(data.sessionVersion) !== String(version)) return null;
    return data;
  } catch (err) { return null; }
}

// ---------------------------------------------------------------------------
// Dates / ids / formatting
// ---------------------------------------------------------------------------

function parseRoom_(raw) {
  var m = String(raw || '').match(/(\d+)/);
  if (!m) return null;
  var n = Number(m[1]);
  return n >= 1 && n <= 10 ? n : null;
}

function requireDate_(raw, label) {
  var s = String(raw || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(label + ' must be a date (YYYY-MM-DD).');
  }
  var d = parseDate_(s);
  if (isNaN(d.getTime())) throw new Error(label + ' is not a valid date.');
  return s;
}

function parseDate_(key) {
  var parts = String(key).split('-');
  return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
}

function formatDateKey_(date) {
  var d = date instanceof Date ? date : new Date(date);
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

/** Serialize a sheet timestamp cell for client transport: Sheets hands
 *  back Date objects for timestamp columns, and a Date anywhere in a
 *  google.script.run return value makes the client success handler
 *  receive null (the admin dashboard then fails reading 'pricing').
 *  Always return a string. */
function dateTimeCell_(cell) {
  if (cell instanceof Date) return cell.toISOString();
  return cell == null ? '' : String(cell);
}

function dateCell_(cell) {
  if (cell instanceof Date) return formatDateKey_(cell);
  var s = String(cell == null ? '' : cell).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : s;
}

function nightsBetween_(moveIn, moveOut) {
  return Math.round((parseDate_(moveOut) - parseDate_(moveIn)) / 86400000);
}

function normaliseRange_(start, end) {
  var s = /^\d{4}-\d{2}-\d{2}$/.test(String(start || '')) ? start : todayKey_();
  var e = /^\d{4}-\d{2}-\d{2}$/.test(String(end || '')) ? end : nextMonthKey_(s.slice(0, 7)) + '-01';
  if (e <= s) e = nextMonthKey_(s.slice(0, 7)) + '-01';
  return { start: s, end: e };
}

function nextMonthKey_(yyyyMm) {
  var parts = yyyyMm.split('-');
  var d = new Date(Number(parts[0]), Number(parts[1]), 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function todayKey_() {
  return formatDateKey_(new Date());
}

function newBookingId_(room) {
  return 'RSGH-' + (room ? room + '-' : '') +
    todayKey_().replace(/-/g, '') + '-' +
    Math.random().toString(36).slice(2, 8).toUpperCase();
}

function newReviewId_() {
  return 'RSGH-REV-' + Date.now().toString(36).toUpperCase();
}

function round2_(n) {
  return Math.round(Number(n) * 100) / 100;
}

function numOr_(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : fallback;
}

/** Resolve the public display name from the Attribution choice.
 *  Attribution stores the guest's choice ("Full name", "First name and
 *  last initial", "Anonymous guest", "Former medical rotation guest")
 *  unless v5 stored a resolved name — in which case it is used as-is. */
function resolveDisplayName_(name, attribution) {
  var a = String(attribution || '').trim();
  var n = String(name || '').trim();
  if (a === 'Anonymous guest') return 'Anonymous guest';
  if (a === 'Former medical rotation guest') return 'Former medical rotation guest';
  if (a === 'Full name') return n || 'Guest';
  if (a === 'First name and last initial') {
    var parts = n.split(/\s+/).filter(Boolean);
    if (!parts.length) return 'Guest';
    if (parts.length === 1) return parts[0];
    return parts[0] + ' ' + parts[parts.length - 1].charAt(0) + '.';
  }
  return a || n || 'Guest';
}

function sendMailSafe_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: body });
  } catch (err) { /* Email must never break a booking/review submit. */ }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function adminHtmlOutput_() {
  return HtmlService.createHtmlOutput(ADMIN_HTML)
    .setTitle('Ravi\u2019s Guest House · Admin');
}

// Admin dashboard HTML — verbatim from the live v5 ?action=admin page
// (extracted Nov 11 2026; only the page itself, not the
// googleusercontent loader wrapper). It calls the google.script.run
// functions implemented above with the same names and shapes.
var ADMIN_HTML = `<!doctype html><html><head><style>
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui;background:#f4f8f8;color:#163342}header{padding:20px;background:#163342;color:white;display:flex;justify-content:space-between;align-items:center}main{max-width:1200px;margin:auto;padding:20px}h1{font-size:24px;margin:0}h2{margin:24px 0 12px}button,input,select,textarea{font:inherit;border:1px solid #b8cbd0;border-radius:7px;padding:10px}button{cursor:pointer;background:white;color:#163342}button.primary{background:#176b77;color:white}input,select,textarea{width:100%;background:white}label{display:block;font-weight:600}section,.room,.record{background:white;border:1px solid #d7e2e2;border-radius:12px;padding:16px;margin-bottom:12px}.rooms{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.room ul{padding-left:18px;font-size:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.row>*{flex:1}.row button{flex:0 0 auto}.fields{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.wide{grid-column:1/-1}.muted{color:#566a74}#message{position:sticky;top:0;background:#e3f1f2;padding:12px;z-index:2;white-space:pre-wrap}.record h3{margin:0 0 6px}.record p{margin:4px 0}#login{max-width:460px;margin:30px auto}dialog{border:0;border-radius:12px;max-width:650px;width:calc(100% - 24px)}dialog::backdrop{background:#0008}[hidden]{display:none!important}@media(max-width:600px){.fields{grid-template-columns:1fr}.wide{grid-column:auto}header{flex-wrap:wrap;gap:10px}}
</style></head><body><header><h1>Ravi’s Guest House ÃÂ· Admin</h1><div class="row"><a style="color:white" href="https://ravisguesthouse.com" target="_blank">Website</a><button id="logout">Sign out</button></div></header><main><p id="message" role="status">Loading…</p><section id="login" hidden><h2>Administrator sign-in</h2><p>Ravi: sign in with your username (your Google address, rgh.cleveland@gmail.com) and the administrator password Rob has set. Rob can open this page while signed in to rob@controllattice.com.</p><form id="login-form"><label>Username<input id="username" type="email" autocomplete="username" placeholder="rgh.cleveland@gmail.com" required></label><label>Password<input id="password" type="password" autocomplete="current-password" required></label><button class="primary">Sign in</button></form></section><div id="dashboard" hidden><div class="row"><label>Calendar month<input id="month" type="month"></label><button id="reload">Refresh</button><button id="new" class="primary">Add reservation or block</button></div><h2>All 10 rooms</h2><div id="rooms" class="rooms"></div><h2>Reservations and requests</h2><div class="row"><label>Status<select id="filter"><option>All</option><option>Pending</option><option>Confirmed</option><option>Maintenance</option><option>Denied</option><option>Cancelled</option></select></label></div><div id="bookings"></div><h2>Guest reviews</h2><div id="reviews"></div><section><h2>Pricing</h2><p>Room prices include any taxes Ravi absorbs. No tax is added to the guest’s total.</p><form id="pricing-form"><label>Proration basis<select id="billing-days"><option value="30">Monthly rate ÃÂ· 30 ÃÂ nights</option><option value="31">Monthly rate ÃÂ· 31 ÃÂ nights</option></select></label><button>Save pricing settings</button></form></section><section><h2>Administrator password</h2><p id="password-status"></p><form id="password-form"><label>New password (at least 14 characters)<input id="new-password" type="password" minlength="14" autocomplete="new-password" required></label><button>Set password</button></form><p><button id="clear-lockout" type="button">Clear sign-in lockout</button> <span id="lockout-status"></span></p></section></div></main><dialog id="edit"><form id="booking-form"><h2 id="edit-title">Reservation</h2><input id="booking-id" type="hidden"><div class="fields"><label>Room<select id="room"></select></label><label>Status<select id="status"><option>Pending</option><option>Confirmed</option><option>Denied</option><option>Cancelled</option><option>Maintenance</option></select></label><label>Move-in<input id="move-in" type="date" required></label><label>Move-out (first unoccupied day)<input id="move-out" type="date" required></label><label>Guest name or block description<input id="guest" required></label><label>Email<input id="email" type="email"></label><label>Payment method<select id="booking-payment"><option value="">Select method</option><option>Credit or debit card</option><option>PayPal</option><option>Venmo</option><option>Zelle</option><option>Cash</option></select></label><label class="wide">Notes<textarea id="notes"></textarea></label></div><p>Confirmed reservations and maintenance blocks update the room calendar. Overlapping stays are prevented. Cancelled records stay available in the history.</p><p id="quote-summary">Choose dates to calculate the stay cost.</p><button id="calculate" type="button">Calculate cost</button><div class="row"><button class="primary">Save</button><button id="close" type="button">Close</button></div></form></dialog><script>
let token=sessionStorage.getItem('ravi-admin-token')||'',data;
const $=id=>document.getElementById(id),message=text=>$('message').textContent=text;
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function call(name,...args){return new Promise((resolve,reject)=>google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[name](...args));}
async function run(job){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{return await job();}catch(e){message(e.message||String(e));}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);}}
async function load(){try{data=await call('adminData',token,$('month').value);$('login').hidden=true;$('dashboard').hidden=false;render();message('Signed in as '+data.actor+'. Calendar dates show occupied nights; move-out is exclusive.');}catch(e){$('login').hidden=false;$('dashboard').hidden=true;message(e.message||String(e));}}
function render(){
$('billing-days').value=data.pricing.daysPerMonth;
$('password-status').textContent=data.passwordConfigured?'An administrator password is configured.':'Set a password for Ravi before sharing this admin link.';
$('rooms').innerHTML=data.rooms.map(r=>'<article class="room"><h3>Room '+r.id+'</h3><p>'+ (r.connected?'Calendar connected':'Calendar not connected')+'</p><form data-rate="'+r.id+'" class="row"><label>Monthly rate ($)<input type="number" min="1" step="0.01" value="'+r.rate+'" required></label><button>Save rate</button></form><ul>'+r.events.map(e=>'<li><b>'+escape(e.start)+' to '+escape(e.end)+'</b><br>'+escape(e.title)+'</li>').join('')+'</ul>'+(r.events.length?'':'<p class="muted">No calendar events this month.</p>')+'</article>').join('');
renderBookings();
$('reviews').innerHTML=data.reviews.length?data.reviews.map((r,i)=>'<article class="record"><h3>'+escape(r[9])+' ÃÂ· '+escape(r[6])+'/5</h3><p>'+escape(r[10])+'</p><p>'+escape(r[2])+' ÃÂ· '+escape(r[3])+' ÃÂ· '+escape(r[4])+'</p><button data-review="'+i+'" data-status="Approved">Approve</button> <button data-review="'+i+'" data-status="Declined">Decline</button> <button data-review="'+i+'" data-status="Pending approval">Return to pending</button></article>').join(''):'<p>No submitted reviews.</p>';
}
$('pricing-form').onsubmit=e=>{e.preventDefault();run(async()=>{await call('adminSavePricing',token,{taxPercent:0,exemptAfterNights:0,daysPerMonth:$('billing-days').value});await load();message('Pricing and tax settings saved.');});};
$('calculate').onclick=()=>run(async()=>{const q=await call('adminQuote',token,{room:$('room').value,moveIn:$('move-in').value,moveOut:$('move-out').value,paymentMethod:$('booking-payment').value});const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);$('quote-summary').textContent=q.nights+' nights ÃÂ· Rent '+money(q.subtotal)+' ('+money(q.monthlyRate)+' ÃÂ· '+q.daysPerMonth+' ÃÂ nights) ÃÂ· '+('Cleaning '+money(q.cleaningFee)+' (nonrefundable) ÃÂ· Security deposit '+money(q.securityDeposit)+' (refundable) ÃÂ· Transaction fee '+money(q.transactionFee)+' ('+(q.feeWaived?'waived for '+q.paymentMethod:'4% for card/PayPal')+') ÃÂ· Total '+money(q.total)+' ÃÂ· Reserve with '+money(q.reservationPayment)+' credited toward total ÃÂ· Remaining '+money(q.balanceAfterReservation)+(q.paymentMethod?'':' ÃÂ· Select payment method for the exact fee')+' ÃÂ· No added tax');});
function renderBookings(){const rows=data.bookings.map((r,i)=>({r,i})).filter(x=>$('filter').value==='All'||x.r[2]===$('filter').value);$('bookings').innerHTML=rows.length?rows.reverse().map(({r,i})=>'<article class="record"><h3>Room '+escape(r[3])+' ÃÂ· '+escape(r[7])+'</h3><p>'+escape(r[4])+' to '+escape(r[5])+' ÃÂ· '+escape(r[2])+'</p><p>'+escape(r[1])+' ÃÂ· '+escape(r[8])+'</p><p>'+escape(r[14])+'</p><button data-edit="'+i+'">Edit / approve / cancel</button></article>').join(''):'<p>No reservations with this status.</p>';}
function edit(index){const r=index==null?null:data.bookings[index];$('booking-id').value=r?r[1]:'';$('room').value=r?r[3]:'1';$('status').value=r?r[2]:'Pending';$('move-in').value=r?r[4]:'';$('move-out').value=r?r[5]:'';$('guest').value=r?r[7]:'';$('email').value=r?r[8]:'';$('notes').value=r?r[14]:'';$('booking-payment').value=r?r[13]:'';$('edit-title').textContent=r?'Edit '+r[1]:'Add reservation or block';$('quote-summary').textContent='Choose dates and calculate the stay cost.';$('edit').showModal();}
$('month').value=new Date().toLocaleDateString('en-CA',{year:'numeric',month:'2-digit'}).slice(0,7);if(!/^\d{4}-\d{2}$/.test($('month').value))$('month').value=new Date().toISOString().slice(0,7);
$('room').innerHTML=Array.from({length:10},(_,i)=>'<option value="'+(i+1)+'">Room '+(i+1)+'</option>').join('');
$('reload').onclick=()=>run(load);$('month').onchange=()=>run(load);$('filter').onchange=renderBookings;$('new').onclick=()=>edit(null);$('close').onclick=()=>$('edit').close();
$('login-form').onsubmit=e=>{e.preventDefault();run(async()=>{const result=await call('adminLogin',$('username').value,$('password').value);$('password').value='';token=result.token;sessionStorage.setItem('ravi-admin-token',token);await load();});};
$('logout').onclick=()=>run(async()=>{await call('adminLogout',token);token='';sessionStorage.removeItem('ravi-admin-token');$('dashboard').hidden=true;$('login').hidden=false;message('Password session ended. If using Google sign-in, sign out of Google to end that session.');});
$('password-form').onsubmit=e=>{e.preventDefault();run(async()=>{await call('adminSetPassword',token,$('new-password').value);$('new-password').value='';await load();message('Administrator password saved.');});};
$('clear-lockout').onclick=()=>{run(async()=>{await call('adminResetLoginLockout',token);$('lockout-status').textContent='Lockout cleared just now.';message('Sign-in lockout cleared.');});};
$('booking-form').onsubmit=e=>{e.preventDefault();run(async()=>{await call('adminSaveBooking',token,{id:$('booking-id').value,room:$('room').value,status:$('status').value,moveIn:$('move-in').value,moveOut:$('move-out').value,name:$('guest').value,email:$('email').value,notes:$('notes').value,paymentMethod:$('booking-payment').value});$('edit').close();await load();message('Reservation saved and calendar updated.');});};
document.addEventListener('click',e=>{const b=e.target.closest('[data-edit]');if(b)edit(Number(b.dataset.edit));const review=e.target.closest('[data-review]');if(review)run(async()=>{await call('adminModerateReview',token,data.reviews[Number(review.dataset.review)][1],review.dataset.status);await load();message('Review status saved.');});});
document.addEventListener('submit',e=>{const form=e.target.closest('[data-rate]');if(form){e.preventDefault();run(async()=>{await call('adminSaveRate',token,form.dataset.rate,form.querySelector('input').value);await load();message('Room rate saved.');});}});load();
</script></body></html>`;
