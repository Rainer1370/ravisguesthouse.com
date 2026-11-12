# Ravi's Student Guest House — backend v6-native

Deployable Google Apps Script backend (`Code.gs`) for
[ravisguesthouse.com](https://ravisguesthouse.com). The v6-native change:
**the Bookings sheet is the source of truth for availability, not Google
Calendar.** Google Calendar is an optional outbound sync only.

> **Reconstruction notice.** The v5 source could **not** be recovered
> (Chuck, Nov 11 2026). `Code.gs` was reconstructed from the live
> `?action=admin` dashboard HTML, the live public API behaviour, Chuck's
> Nov 11 2026 handover, and the public frontend. It is **not** the v5
> source. Step 1 below — retrieve and diff the real v5 source — is
> mandatory before deploying.

## 0. What changed vs v5

| Area | v5 (live) | v6-native (this branch) |
|---|---|---|
| Availability source | Per-room Google Calendars (broken: backend runs as rob@, no calendar access; dashboard showed "calendar not connected" for all 10 rooms) | Bookings sheet. Only **Confirmed** and **Maintenance** block dates. Pending / Denied / Cancelled do not block. Move-out is the first unblocked date. |
| Calendar | Required for availability | Optional outbound sync only. Sheets commit first; a calendar failure leaves the native reservation valid and flags `SYNC_PENDING_<bookingId>` for retry. |
| Admin auth | Google identity exact-match rob@controllattice.com, else password | Same (preserved). No password was configured at last check. |
| Sheet layout | Booking Requests A–P, Review Submissions A–L, Admin Audit A–D | Same, untouched. No new sheet columns. Calendar event mappings stay in script properties (`BOOKING_EVENT_<bookingId>`). |
| Rates / pricing | `ROOM_RATES` + `BILLING_DAYS` script properties | Same, plus `PRICING_OVERRIDES` (fee-on-deposit etc.). Quote formula unchanged: 4% on rent + cleaning + refundable deposit, unless Jag changes `feeOnDeposit`. |
| Public API | GET availability, `?action=rates`, `?action=quote`, `?action=reviews`, `?action=admin`, POST `action=booking`, POST `action=review` | Same routes and shapes. Availability responses add `source:"native"`; when the sheet cannot be read they report `available:false` + `unavailableToVerify:true` instead of stale dates. |

## 1. Before you deploy — verify against the live system

Do these **before** touching the Apps Script project. Nothing in this
branch touches live data; these checks are read-only.

1. **Retrieve the authoritative v5 source** (if access allows) and diff
   it against `backend/Code.gs`:
   ```
   GET https://script.googleapis.com/v1/projects/1jAxus9CbLHOzMM3W3-sPAjE93eYsPqFTVyROAa9jxK9oFmHP3jHtOmd0/content?versionNumber=5
   ```
   Apps Script project ID: `1jAxus9CbLHOzMM3W3-sPAjE93eYsPqFTVyROAa9jxK9oFmHP3jHtOmd0`.
   Save the export. Reconcile **any** difference in sheet layout, API
   shape, email recipients, or auth before deploying — do not assume
   this reconstruction is complete.
2. **Spreadsheet.** Confirm script property `BOOKING_SPREADSHEET_ID`
   points at the spreadsheet named **"Ravi Guest House Booking
   Requests"** (Rob can find the ID in the Apps Script project
   settings). **Do not run the v5 `setupBackend()` to "find" it** — it
   can create a new spreadsheet if the property is missing. The v6
   `setupBackend()` in this branch is safe (it never creates a
   spreadsheet and returns an error if the property is missing), but
   still confirm the property first.
3. **Tabs and headers** — exact, header row 1:
   - `Booking Requests` (A–P): Submitted | Booking ID | Status | Room |
     Move-in | Move-out | Nights | Name | Email | Guest type |
     Contact preference | Bike | Payment preference | Payment method |
     Notes | Source
   - `Review Submissions` (A–L): Submitted | Review ID | Status | Name |
     Email | Room | Rating | Stay began | Stay ended | Attribution |
     Review | Source
   - `Admin Audit` (A–D): Time | Administrator | Action | Reference
   - Spot-check a few rows: Booking ID / Status / Room / dates / Name /
     Email / Payment method / Notes line up with the columns above.
     In particular, confirm the guest's message from the booking form
     is stored in **Notes** (col O) — this reconstruction assumes so;
     if it lives elsewhere, fix `buildBookingRow_` / the Notes mapping
     before deploying.
4. **Script properties.** Confirm `ROOM_RATES` (room→monthly-rate JSON;
   expected 1:900, 2:750, 3:900, 4:900, 5:900, 6:750, 7:900, 8:925,
   9:925, 10:925) and `BILLING_DAYS` (30). Note any
   `BOOKING_EVENT_<bookingId>` properties (calendar event mappings —
   v6 preserves and reuses them) and any `CALENDAR_ROOM_1`…`CALENDAR_ROOM_10`
   properties (optional sync only).
   **Verified calendar IDs** (Nov 11 2026; rainer1370@gmail.com can
   read Rooms 1–10 as **reader only**, rob@ cannot see them at all —
   that is the v5 root cause; see `NATIVE_CALENDAR_DESIGN.md` §7 for
   the full table). These IDs are documentation only; the code does
   not hardcode them. Set them as `CALENDAR_ROOM_*` properties only
   if/when Jag wants sync or a one-off import, and only after the
   calendars are shared with the executing account (rob@).
5. **Auth.** Confirm no administrator password is set (expected: none
   at last check) and that Rob can open `?action=admin` while signed
   in to rob@controllattice.com.
6. **Existing reservations.** Decide with Jag **before** cutover how
   existing Calendar-only reservations are handled (see §4). Do not
   import anything until he confirms — especially entries marked free
   or titled "Available".

## 2. Tests (local, no live services)

```sh
node backend/test-code-gs.js
```

23 tests, all passing as of Nov 11 2026. They cover: availability
from Confirmed/Maintenance only (Pending/Denied/Cancelled do not
block), move-out day unblocked, sheet-unreadable → unavailable-to-
verify, overlap rejection on submit and on admin save (excluding the
booking's own ID), 21-night minimum, quote math (21-night Room 1 =
$722.80; Venmo waives the fee → $695; `feeOnDeposit=false` → $720.80),
admin auth (rob@ Google identity only; rgh.cleveland@gmail.com is **not**
auto-allowed under the v5 exact-match rule; Jag signs in with username
rgh.cleveland@gmail.com + password set/login/logout, 14-char minimum, hash-only storage), calendar failure never breaking
availability or bookings (sync flagged for retry), rates, approved-
only reviews with resolved attribution and no guest email, calendar
import dry-run/import/dedupe, and `setupBackend` safety.

## 3. Deploy

1. In the Apps Script project, replace the contents of `Code.gs` with
   `backend/Code.gs` (the admin dashboard HTML is embedded in
   `Code.gs` as `ADMIN_HTML` — there is no separate HTML file to
   deploy).
2. **Run `setupBackend()` once from the script editor** (it is safe:
   it creates missing tabs with the exact headers above, seeds
   `ROOM_RATES` / `BILLING_DAYS` only if absent, and never overwrites
   existing data). Read its `warnings` — any header mismatch must be
   resolved before going live.
3. Create a **new version** of the **existing** web-app deployment
   (Deploy → Manage deployments → edit the live deployment → Version:
   create new version). Keep:
   - **Execute as:** Me (rob@controllattice.com)
   - **Who has access:** Anyone
   - This keeps the existing exec URL, so `index.html` needs no URL
     change. **If you create a brand-new deployment instead, the exec
     URL changes** — update `AVAILABILITY_API_URL` in `index.html`
     and the footer Admin link to the new URL before publishing the
     frontend.
4. **Do not switch to "Execute as user"** without re-testing auth:
   under Execute-as-me, `Session.getActiveUser()` is the visitor and
   only rob@ auto-allows; Jag uses the password. Under Execute-as-
   user, the sheet/calendar access would run as the visitor and the
   admin identity rule would need rethinking (see
   `NATIVE_CALENDAR_DESIGN.md`).
5. Smoke-test the new version (see §5) **before** publishing the
   frontend changes in `index.html` on this branch.
6. Rob sets the administrator password: open `?action=admin` while
   signed in to rob@controllattice.com → Administrator password →
   set a password (min 14 characters) → share it with Jag securely.
   Jag then signs in with that password. (Password storage is salt +
   iterated SHA-256 only; rotating it invalidates existing tokens.)

## 4. Cutover: carry forward existing Calendar-only reservations

Run **once**, after the backend is deployed and smoke-tested, and
only after Jag confirms. **Prerequisite:** the import runs as rob@
(Execute-as-me), which currently cannot see the room calendars at
all — Jag must first share Rooms 1–10 with rob@controllattice.com
(reader access is enough for the import). Until then the dry run
will report an error per room.

1. In the admin dashboard (via `google.script.run`, e.g. from the
   script editor or a small admin call), run
   `adminImportCalendarEvents(token, { dryRun: true, monthsAhead: 12 })`
   and review the result: `wouldImport`, `skippedDuplicates`,
   `skippedFree` (free / "Available" entries — **never auto-imported**;
   ask Jag about each one), `errors`.
   **Transparency warning:** Google "free" transparency is
   `transparent`, not the word "free". Verified example: Room 1's
   "Room 1 - Shashwat Shrivastava", 2026-05-01 to 2027-06-01,
   creator jrslmgt@gmail.com, is transparent — the same 13-month
   span the old frontend hardcoded as Room 1's blocked snapshot,
   yet it does not block time in Google terms. Ask Jag what it is
   before importing it (or anything like it) as a Confirmed block.
2. If the dry run looks right, run it again with `dryRun: false`.
   Imported rows are **Confirmed**, Source `google-calendar-import`,
   and the existing `BOOKING_EVENT_<id>` mappings are preserved so a
   later sync does not create duplicate calendar events.
3. Re-running the import is safe: it deduplicates by room + dates
   against existing Confirmed/Maintenance rows and by event mapping.

## 5. Smoke test after deploy (live, in order)

1. `GET <exec>?start=2026-11-11&end=2026-12-11` — rooms return
   `source:"native"` and blocked ranges matching the sheet's
   Confirmed/Maintenance rows (not the old "calendar not connected").
2. `GET <exec>?action=rates` — rates match the `ROOM_RATES` property.
3. `GET <exec>?action=quote&room=1&moveIn=2027-02-01&moveOut=2027-02-22`
   — subtotal 630, transactionFee 27.8, total **722.8**.
4. `GET <exec>?action=reviews` — approved reviews only, no emails.
5. Open `?action=admin` as Rob — dashboard loads, rooms show
   "Calendar connected" (native), rates editable.
6. As a guest, submit a test booking for a free room/dates → Pending
   in the sheet, **no** calendar block, emails received.
7. As Jag (password), approve it in the admin → Confirmed, availability
   now shows the dates blocked; move the dates → availability follows;
   cancel it → dates free again, history row stays Cancelled.
8. If calendars are configured, check the calendar event was created /
   moved / deleted; if a calendar is unreachable, the reservation must
   still be valid and appear in `adminData` → `syncPending`.
9. Publish the frontend (`index.html` on this branch) only after 1–8
   pass, then repeat 6–7 against the live site.

## 6. Rollback

- **Backend:** in the Apps Script project, Deploy → Manage deployments
  → edit the live deployment → set Version back to the **v5** version.
  The exec URL does not change, so the frontend keeps working against
  v5. Keep the saved v5 source export from §1 for this.
- **Frontend:** revert `index.html` to `main` (commit `b7f72a6`) and
  republish. The v5 frontend falls back to its hardcoded snapshot
  when the calendar cannot be reached, so it is safe to run against
  either backend version — but availability will again be calendar-
  based under v5.
- **Data:** v6 writes use the same sheet columns, so rolling back the
  code does not require a data migration. Bookings created by v6 stay
  in the sheet with their original statuses.

## 7. Open questions (for Jag — see NATIVE_CALENDAR_DESIGN.md)

- Does the 4% transaction fee apply to the refundable deposit?
  (Live formula says yes; `feeOnDeposit` is now configurable.)
- Prorate monthly rates on 30 or 31 days? (Default 30; admin can
  switch to 31.)
- Existing Calendar-only reservations: import all, some, or none?
  What about entries marked free / "Available"?
- Room 4 photos: still to come. Room 8 stays "Photos coming soon".
- Should Jag's Google account (rgh.cleveland@gmail.com) ever auto-allow in
  the admin, or stay password-only?
