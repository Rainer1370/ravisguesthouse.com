# Native calendar — design (v6-native)

Ravi's Student Guest House — `ravisguesthouse.com`.
Branch: `native-calendar`. Nothing here is deployed; see `README.md`
for the deployment checklist and rollback.

## 1. Why native

Verified Nov 11 2026 (rainer1370@gmail.com account):

- Rooms 1–10 **can be read, but only as reader** — `accessRole:
  reader` on all 10 calendars, no write access.
- The Apps Script backend runs as **rob@controllattice.com and cannot
  see the room calendars at all** (`calendarFound:false` on the live
  availability endpoint). That is the root cause of the v5 failure:
  the dashboard showed "calendar not connected" for all 10 rooms, and
  no calendar read or write could ever succeed from the backend.
- Fixing that by sharing calendars with rob@ would restore Google
  Calendar as the source of truth — but it would keep the booking
  system dependent on one person's calendar sharing, on calendar
  names/IDs, and on Google's notion of "busy". Rob chose a native
  in-site calendar instead: the Bookings sheet is the source of
  truth, and Google Calendar (if used at all) is an outbound sync.

## 2. Source of truth

The **Booking Requests** sheet in the spreadsheet "Ravi Guest House
Booking Requests" (ID in script property `BOOKING_SPREADSHEET_ID`).

Exact schema (Chuck, Nov 11 2026 — authoritative, do not change):

- **Booking Requests (A–P):** Submitted | Booking ID | Status | Room |
  Move-in | Move-out | Nights | Name | Email | Guest type |
  Contact preference | Bike | Payment preference | Payment method |
  Notes | Source
- **Review Submissions (A–L):** Submitted | Review ID | Status | Name |
  Email | Room | Rating | Stay began | Stay ended | Attribution |
  Review | Source
- **Admin Audit (A–D):** Time | Administrator | Action | Reference

Rates and pricing are **not** in Sheets: `ROOM_RATES` (room→monthly-
rate JSON) and `BILLING_DAYS` (30 or 31, default 30) are script
properties. Calendar event mappings are **not** sheet columns either:
`BOOKING_EVENT_<bookingId>` script properties hold
`calendarId|eventId` (v5 convention, preserved so a later sync does
not create duplicate events).

## 3. Availability rules

- **Blocking statuses: Confirmed and Maintenance only.** Pending,
  Denied and Cancelled do **not** block. A Pending request is a
  request, not a hold; Jag's approval (status → Confirmed) creates
  the block.
- **Move-out is the first unblocked date.** A new stay may start on
  the previous guest's move-out day. Overlap is the half-open test
  `moveIn < otherMoveOut && otherMoveIn < moveOut`.
- **21-night minimum**, enforced server-side on guest submit, on
  admin save, and in quotes.
- **Conflict check and write happen under the same script lock**
  (`LockService.getScriptLock()`), on both guest submit and admin
  save, so two simultaneous requests cannot double-book a room.
- **On a room/date edit, the booking's own ID is excluded** from its
  own overlap check (editing a booking must not clash with itself).
- **Cancellation is a status change.** The row stays in the sheet
  (history intact); the dates simply stop blocking.
- **If the sheet cannot be read, availability reports every room as
  unavailable to verify** (`available:false`,
  `unavailableToVerify:true`, `sheetError` set, `blocked:[]`). The
  frontend shows no dates as occupied in that case and the server
  re-validates on submit. Hardcoded fallback dates are gone — the old
  frontend's September 21 2026 snapshot is removed in `index.html`
  on this branch.

## 4. Booking flow

1. Guest picks a room and dates → the frontend shows live native
   availability and a live quote (`?action=quote`).
2. Guest submits → server re-checks overlap against Confirmed /
   Maintenance, enforces the 21-night minimum, and appends a
   **Pending** row (Source `website`). No calendar block is created.
   Jag and Rob are emailed (best-effort); the guest gets a
   confirmation that the request is Pending.
3. Jag approves in the admin (status → **Confirmed**) → the dates
   block. Outbound calendar sync (if configured) runs **after** the
   sheet commit.
4. Jag can move dates (overlap re-checked, own ID excluded), deny,
   cancel, or add a **Maintenance** block from the same admin form.
   A booking for "Any suitable room" stays Pending until Jag assigns
   a specific room in the admin.

## 5. Pricing

Unchanged from live v5 (verified Nov 11 2026):

- Monthly rates: $750 rooms 2 & 6; $900 rooms 1, 3, 4, 5, 7;
  $925 rooms 8–10. Editable in the admin (`ROOM_RATES` property).
- $15 nonrefundable cleaning fee, $50 refundable security deposit,
  $100 upfront reservation payment credited toward the total, no
  added tax.
- 4% transaction fee, **waived for Venmo, Zelle and Cash**.
- The live formula applies the 4% to **rent + cleaning + the
  refundable deposit**: 21-night Room 1 = rent $630 + $15 + $50 =
  $695, fee $27.80, **total $722.80**. The test suite pins this.
- `feeOnDeposit` is now configurable via `adminSavePricing`
  (stored in `PRICING_OVERRIDES`); changing it changes the fee base
  and must be Jag's explicit decision — it is **not** silently
  changed here. `BILLING_DAYS` (30/31) is the proration basis.

## 6. Auth

Deployment is preserved from v5: **Execute as me
(rob@controllattice.com), Who has access: Anyone.**

- Google identity first: `adminIdentity_` exact-matches
  **rob@controllattice.com only**. Rob opens `?action=admin` while
  signed in to that account and needs no password.
- **Jag uses username + password.** His username is his Google address,
  `jrslmgt@gmail.com` (case-insensitive). `adminLogin(username, password)`
  rejects a wrong username exactly like a wrong password, counting toward
  the same lockout, and records the token actor as jrslmgt@gmail.com.
  `adminSetPassword` requires an already-authorised admin, min 14
  characters, stores salt + iterated SHA-256 digest in script properties
  (never plaintext), and rotates the session version (invalidating
  existing tokens). `adminLogin` rate-limits via the script cache
  (5 failed attempts → 10-minute lockout) and returns an opaque token
  cached up to 6 hours. `adminLogout` removes the token. A password
  was set Nov 11 2026 (live v5 admin, not yet v6).
- `jrslmgt@gmail.com` is **not** auto-allowed under the v5
  exact-match rule, and this reconstruction does not change that:
  under Execute-as-me it is unverified whether
  `Session.getActiveUser()` returns Jag's address in a way that
  could be trusted for auto-allow. Keep Jag on the password flow
  until that is verified live (open question below).
- All admin reads/writes are server-side behind `requireAdmin_`.
  Public routes return only room/date blocks (no guest names or
  emails) and approved reviews with attribution (no guest email).

## 7. Google Calendar sync (optional, outbound only)

- Calendar IDs are read from script properties
  `CALENDAR_ROOM_1`…`CALENDAR_ROOM_10`. If a room has none, sync is
  a no-op (`status:"not-configured"`).
- **Verified calendar IDs** (Nov 11 2026, reader access via
  rainer1370@gmail.com; the backend account rob@ cannot see them):

  | Room | Calendar ID (`@group.calendar.google.com`) |
  |---|---|
  | 1 | `2efa9ab53afc766921cdaef15d85869ab8f1fb0643539118fe12b4278a57f716` |
  | 2 | `f030de575f1eb177f14e5ffda1005d04dc61747facf7fe6ef5aa22798cf21407` |
  | 3 | `551a056b8348277394ccb6a51442872136f305f8fa14a9d2c49ac3d4dc719bf3` |
  | 4 | `e7aeb2c13a0c54e63128aef76d85851c38ba312fc7f4361f61dd8ce65365cbaf` |
  | 5 | `d654f3737954aa747d1899ac11f71b2589e3b759e2ad32d739a309ca1584feff` |
  | 6 | `3a8112e48e9995336de692ff9c4f8782ad9a01ec556d4fc81966017f93f67cd7` |
  | 7 | `cdc0e924cfdb7bac594f924106724013c3c1af54447ab11e797eb0375a36dafa` |
  | 8 | `5709548a892e030fb9ef5d04347830a176b1bda1d3f1045f00a7f5a9b81e8b9b` |
  | 9 | `58f34ae3d3f045c831f62f2ec049446f3650892b832771fdcda3d89b4da32b43` |
  | 10 | `e740e2daa9fa3f9fdd4d0dfc631751a1c22f4e94dcaa5852834bc63f22b730fd` |

  These IDs are documentation only — the code does not hardcode
  them. Set them as properties only if/when Jag wants sync or a
  one-off import, and only after the calendars are shared with the
  executing account.
- **Commit first, sync second.** A Confirmed/Maintenance save writes
  the sheet, then best-effort creates/updates the calendar event
  (reusing the `BOOKING_EVENT_<id>` mapping so no duplicate is
  created). A calendar failure leaves the native reservation valid
  and records `SYNC_PENDING_<bookingId>`; the admin dashboard
  surfaces pending syncs. Cancelling / denying / returning a booking
  to Pending deletes its calendar event (best-effort).
- **Calendar changes must never overwrite native reservations.**
  There is no inbound sync: nothing reads calendar state to change
  sheet data except the explicit, one-off import below.

## 8. One-off import of Calendar-only reservations

`adminImportCalendarEvents(token, { dryRun, monthsAhead })` — never
runs automatically; an admin calls it explicitly, dry-run first.

- Imports events as **Confirmed** rows, Source
  `google-calendar-import`, with the `BOOKING_EVENT_<id>` mapping
  stored so later syncs do not duplicate them.
- **Deduplication:** an event is skipped when a Confirmed/Maintenance
  row already covers the same room + dates, or its event mapping
  already exists. Re-running the import is safe.
- **Free / "Available" events are never imported.** They are
  returned in `skippedFree` (room, title, dates, transparency,
  creator) for Jag to decide on, one by one.
- **Transparency is the trap.** Google "free" transparency is
  `transparent` (`CalendarApp.EventTransparency.FREE`), not the word
  "free". Verified example (Nov 11 2026): Room 1's only event in the
  Nov 2026–Jan 2027 window is **"Room 1 - Shashwat Shrivastava",
  2026-05-01 to 2027-06-01, creator jrslmgt@gmail.com, transparency
  transparent**. That 13-month span is exactly the range the old
  frontend hardcoded as Room 1's blocked snapshot — yet as a
  transparent event it does **not** block time in Google terms. It
  may be a long-term stay recorded as a marker, or it may not be a
  booking at all. The import treats an event as free when its
  transparency is FREE / "free" / "transparent", or its title
  contains "Available", and surfaces it — never auto-imports it.
  Guest names are taken from the title with a "Room N – " prefix
  stripped ("Room 1 - Shashwat Shrivastava" → "Shashwat
  Shrivastava").
- **Prerequisite:** the import runs as rob@ (Execute-as-me), which
  currently cannot see the room calendars at all. Before importing,
  Jag must share Rooms 1–10 with rob@controllattice.com — reader
  access is enough for the import (edit access is needed only for
  outbound sync). Until then the dry run will report an error per
  room, which is the correct signal, not a bug.

## 9. Frontend changes (this branch, `index.html`)

- Hardcoded stale blocked snapshots removed (all rooms `blocked:[]`);
  the `SNAPSHOT_VERIFIED` September 21 2026 constant is gone.
- Availability comes only from the native backend. If the backend
  cannot be reached, **no dates are shown as occupied** — the page
  says so plainly, and the server re-validates on submit.
- Room prices load live via `?action=rates` (with the existing rates
  as the initial display; the quote is always server-calculated).
- Live quote summary in the booking form via `?action=quote` when a
  room, dates and payment method are chosen: nights, rent, cleaning,
  refundable deposit, transaction fee or waiver, total, $100 due
  upfront, remaining balance, no added tax.
- PayPal and Cash added to the payment-method options (fee: PayPal
  pays the 4%, Cash is waived — same as Venmo/Zelle).
- Footer "Admin calendar" (Google Calendar) link replaced with an
  **Admin** link to the Apps Script admin URL (`?action=admin`).
  Existing contact/payment details are unchanged.
- Rooms 4 and 8 still show "photos coming soon" (no photos exist
  for them in the repo) — verified, left as is.

## 10. Open questions (for Jag / Rob)

1. **4% on the refundable deposit?** Live formula says yes; now
   configurable via `feeOnDeposit`. Jag to confirm.
2. **30 vs 31 days** to prorate monthly rates? Default 30; the admin
   can switch to 31.
3. **Existing Calendar-only reservations:** import all, some, or
   none? In particular, what is the Room 1 Shashwat Shrivastava
   2026-05-01–2027-06-01 transparent event — a real long-term stay
   to import as Confirmed, or a marker to leave out?
4. **Free / "Available" calendar entries:** how does Jag use them,
   and should any of them become native Maintenance blocks?
5. **Jag's admin access:** password-only (current), or should
   jrslmgt@gmail.com ever auto-allow via Google identity? Needs a
   live verification under the Execute-as-me deployment first.
6. **Room 4 photos:** still to come; Room 8 stays "Photos coming
   soon" until its photos arrive.
7. **Payment provider:** online payment is still not active on the
   live site (the $100 hold / full amount is collected only after
   Jag confirms, via Zelle / Venmo / Invoice Fly). Out of scope
   for this branch, but the quote already shows the amounts.
