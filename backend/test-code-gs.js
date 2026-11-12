#!/usr/bin/env node
/**
 * Tests for backend/Code.gs (v6-native) — run with: node backend/test-code-gs.js
 *
 * Loads Code.gs into a vm context with mocked Apps Script services
 * (SpreadsheetApp, PropertiesService, CacheService, LockService, Session,
 * Utilities, ContentService, HtmlService, MailApp, CalendarApp).
 * No live Google service is touched.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const CODE = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');

const BOOKING_HEADERS = ['Submitted', 'Booking ID', 'Status', 'Room',
  'Move-in', 'Move-out', 'Nights', 'Name', 'Email', 'Guest type',
  'Contact preference', 'Bike', 'Payment preference', 'Payment method',
  'Notes', 'Source'];
const REVIEW_HEADERS = ['Submitted', 'Review ID', 'Status', 'Name', 'Email',
  'Room', 'Rating', 'Stay began', 'Stay ended', 'Attribution', 'Review',
  'Source'];
const AUDIT_HEADERS = ['Time', 'Administrator', 'Action', 'Reference'];

function makeSheet(name, headers, rows) {
  const data = [headers.slice()];
  rows.forEach((r) => data.push(r.slice()));
  return {
    name,
    getDataRange() {
      return { getValues: () => data.map((r) => r.slice()) };
    },
    getRange(r, c, n, m) {
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < n; i++) {
            const row = [];
            for (let j = 0; j < m; j++) row.push(data[r - 1 + i] ? data[r - 1 + i][c - 1 + j] : '');
            out.push(row);
          }
          return out;
        },
        setValues(vals) {
          vals.forEach((row, i) => {
            data[r - 1 + i] = row.slice();
          });
        },
      };
    },
    appendRow(row) { data.push(row.slice()); },
    _data: data,
  };
}

function makeSpreadsheet() {
  const sheets = {};
  sheets['Booking Requests'] = makeSheet('Booking Requests', BOOKING_HEADERS, [
    ['2026-11-01', 'RSGH-1', 'Confirmed', '1', '2026-12-01', '2026-12-22', 21, 'Alice Adams', 'alice@example.com', 'Medical student or resident', 'Available when I need help', 'No', '$100 reservation hold', 'Venmo', '', 'website'],
    ['2026-11-02', 'RSGH-2', 'Pending', '1', '2026-12-25', '2027-01-15', 21, 'Bob Baker', 'bob@example.com', 'Student', 'Minimal contact and maximum independence', 'No', '$100 reservation hold', '', 'Wants quiet floor', 'website'],
    ['2026-11-03', 'RSGH-3', 'Maintenance', '2', '2026-11-20', '2026-11-25', 5, 'Plumbing repair', '', '', '', '', '', '', '', 'admin'],
    ['2026-11-04', 'RSGH-4', 'Cancelled', '1', '2026-12-05', '2026-12-10', 5, 'Cancelled Guest', 'c@example.com', 'Student', '', 'No', '', '', '', 'website'],
    ['2026-11-05', 'RSGH-5', 'Denied', '3', '2026-12-01', '2026-12-22', 21, 'Denied Guest', 'd@example.com', 'Student', '', 'No', '', '', '', 'website'],
  ]);
  sheets['Review Submissions'] = makeSheet('Review Submissions', REVIEW_HEADERS, [
    ['2026-10-01', 'RSGH-REV-1', 'Approved', 'Maria Lopez', 'maria@example.com', 'Room 1', 5, '2026-06', '2026-09', 'Full name', 'Wonderful stay, felt at home.', 'website'],
    ['2026-10-02', 'RSGH-REV-2', 'Pending approval', 'Sam Smith', 'sam@example.com', 'Room 2', 4, '2026-07', '2026-08', 'Anonymous guest', 'Good, quiet room.', 'website'],
  ]);
  sheets['Admin Audit'] = makeSheet('Admin Audit', AUDIT_HEADERS, []);
  return {
    _sheets: sheets,
    getId: () => 'test-spreadsheet-id',
    getSheetByName: (name) => sheets[name] || null,
    insertSheet: (name) => {
      const s = makeSheet(name, [], []);
      sheets[name] = s;
      return s;
    },
  };
}

function fresh() {
  const props = new Map();
  props.set('BOOKING_SPREADSHEET_ID', 'test-spreadsheet-id');
  props.set('ROOM_RATES', JSON.stringify({ 1: 900, 2: 750, 3: 900, 4: 900, 5: 900, 6: 750, 7: 900, 8: 925, 9: 925, 10: 925 }));
  props.set('BILLING_DAYS', '30');
  const cache = new Map();
  const mails = [];
  const calendars = {}; // id -> { events: [], throwOnGet: bool }
  const ss = makeSpreadsheet();
  const state = { activeEmail: 'rob@controllattice.com', props, cache, mails, calendars, ss };

  const sandbox = {
    console,
    Math, JSON, Date, Number, String, Array, Object, Error, RegExp,
    isFinite,
    __state: state,
    SpreadsheetApp: {
      openById(id) {
        if (id !== 'test-spreadsheet-id') throw new Error('Spreadsheet not found: ' + id);
        return ss;
      },
      getActiveSpreadsheet: () => null,
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: (k) => (props.has(k) ? props.get(k) : null),
          setProperty: (k, v) => props.set(k, String(v)),
          deleteProperty: (k) => props.delete(k),
          getProperties: () => {
            const o = {};
            props.forEach((v, k) => { o[k] = v; });
            return o;
          },
        };
      },
    },
    CacheService: {
      getScriptCache() {
        return {
          get: (k) => (cache.has(k) ? cache.get(k) : null),
          put: (k, v) => cache.set(k, String(v)),
          remove: (k) => cache.delete(k),
        };
      },
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => state.activeEmail }),
      getScriptTimeZone: () => 'America/New_York',
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest(_alg, str) {
        const buf = crypto.createHash('sha256').update(String(str), 'utf8').digest();
        return Array.from(buf, (b) => (b > 127 ? b - 256 : b));
      },
      getUuid: () => crypto.randomUUID(),
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) {
        const out = { content: s };
        out.setMimeType = () => out;
        out.getContent = () => out.content;
        return out;
      },
    },
    HtmlService: {
      createHtmlOutput(html) {
        const out = { content: html };
        out.setTitle = () => out;
        out.getContent = () => out.content;
        return out;
      },
    },
    MailApp: {
      sendEmail(msg) { mails.push(msg); },
    },
    CalendarApp: {
      EventTransparency: { FREE: 'FREE', BUSY: 'BUSY' },
      getCalendarById(id) {
        const cal = calendars[id];
        if (!cal) return null;
        if (cal.throwOnGet) throw new Error('CalendarApp unavailable (simulated)');
        return {
          getEvents: () => cal.events,
          createAllDayEvent(title, start, end) {
            const ev = {
              _id: 'ev-' + Math.random().toString(36).slice(2, 8),
              _title: title, _start: start, _end: end,
              getId() { return this._id; },
              getTitle() { return this._title; },
              setTitle(t) { this._title = t; },
              setAllDayDates(s, e) { this._start = s; this._end = e; },
              deleteEvent() { this._deleted = true; },
              getStartTime() { return this._start; },
              getEndTime() { return this._end; },
              getTransparency() { return 'BUSY'; },
            };
            cal.created = cal.created || [];
            cal.created.push(ev);
            return ev;
          },
          getEventById(eventId) {
            const all = (cal.events || []).concat(cal.created || []);
            return all.find((e) => e.getId() === eventId) || null;
          },
        };
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(CODE, sandbox, { filename: 'Code.gs' });
  return { sandbox, state, ss, props, cache, mails, calendars };
}

function getJson(ctx, params) {
  const out = ctx.sandbox.doGet({ parameter: params });
  return JSON.parse(out.getContent());
}
function postJson(ctx, params) {
  const out = ctx.sandbox.doPost({ parameter: params });
  return JSON.parse(out.getContent());
}

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS  ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
  }
}

// --- 1. Availability: only Confirmed / Maintenance block -------------------
test('availability: Confirmed and Maintenance block, Pending/Denied/Cancelled do not', () => {
  const ctx = fresh();
  const res = getJson(ctx, { start: '2026-12-01', end: '2027-01-01' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.source, 'native');
  const r1 = res.rooms.find((r) => r.id === 1);
  assert.deepStrictEqual(r1.blocked, [['2026-12-01', '2026-12-22']]);
  assert.strictEqual(r1.available, false);
  const r2 = res.rooms.find((r) => r.id === 2);
  assert.deepStrictEqual(r2.blocked, []);
  assert.strictEqual(r2.available, true);
  const r3 = res.rooms.find((r) => r.id === 3);
  assert.deepStrictEqual(r3.blocked, []);
  assert.strictEqual(r3.available, true);
});

test('availability: move-out day is the first unblocked day', () => {
  const ctx = fresh();
  const res = getJson(ctx, { start: '2026-12-22', end: '2026-12-25' });
  const r1 = res.rooms.find((r) => r.id === 1);
  assert.strictEqual(r1.available, true);
  assert.deepStrictEqual(r1.blocked, []);
});

test('availability: sheet unreadable reports unavailable-to-verify, never stale dates', () => {
  const ctx = fresh();
  ctx.props.set('BOOKING_SPREADSHEET_ID', 'does-not-exist');
  const res = getJson(ctx, { start: '2026-12-01', end: '2027-01-01' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sheetError != null, true);
  res.rooms.forEach((r) => {
    assert.strictEqual(r.available, false);
    assert.strictEqual(r.unavailableToVerify, true);
    assert.deepStrictEqual(r.blocked, []);
  });
});

// --- 2. Overlap rejection ---------------------------------------------------
test('booking submit: overlapping a Confirmed stay is rejected', () => {
  const ctx = fresh();
  const res = postJson(ctx, {
    action: 'booking', bookingId: 'RSGH-TEST-1', name: 'New Guest',
    email: 'new@example.com', room: 'Room 1',
    moveIn: '2026-12-10', moveOut: '2027-01-05',
    guestType: 'Student', contactStyle: '', bike: 'No',
    paymentChoice: '$100 reservation hold', paymentMethod: 'Venmo', message: '',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /overlap/i);
});

test('booking submit: starting on a Confirmed move-out day is allowed (Pending does not block)', () => {
  const ctx = fresh();
  const res = postJson(ctx, {
    action: 'booking', bookingId: 'RSGH-TEST-2', name: 'New Guest',
    email: 'new@example.com', room: 'Room 1',
    moveIn: '2026-12-22', moveOut: '2027-01-12',
    guestType: 'Student', contactStyle: '', bike: 'No',
    paymentChoice: '$100 reservation hold', paymentMethod: 'Venmo', message: 'Hello',
  });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.status, 'Pending');
  // Stored as Pending with the guest message in Notes (col 15).
  const rows = ctx.ss._sheets['Booking Requests']._data;
  const added = rows.find((r) => r[1] === 'RSGH-TEST-2');
  assert.ok(added);
  assert.strictEqual(added[2], 'Pending');
  assert.strictEqual(added[14], 'Hello');
  assert.strictEqual(added[15], 'website');
});

// --- 3. 21-night minimum ----------------------------------------------------
test('booking submit: under 21 nights is rejected', () => {
  const ctx = fresh();
  const res = postJson(ctx, {
    action: 'booking', name: 'Short Stay', email: 's@example.com',
    room: 'Room 3', moveIn: '2027-02-01', moveOut: '2027-02-11',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /21 nights/);
});

// --- 4. Quote math (live v5 test: 21-night Room 1 = $722.80) ---------------
test('quote: 21-night Room 1 totals $722.80 (4% on rent+cleaning+deposit)', () => {
  const ctx = fresh();
  const res = getJson(ctx, { action: 'quote', room: '1', moveIn: '2027-02-01', moveOut: '2027-02-22', paymentMethod: '' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.nights, 21);
  assert.strictEqual(res.subtotal, 630);
  assert.strictEqual(res.cleaningFee, 15);
  assert.strictEqual(res.securityDeposit, 50);
  assert.strictEqual(res.transactionFee, 27.8);
  assert.strictEqual(res.total, 722.8);
  assert.strictEqual(res.reservationPayment, 100);
  assert.strictEqual(res.balanceAfterReservation, 622.8);
});

test('quote: Venmo waives the fee (total $695)', () => {
  const ctx = fresh();
  const res = getJson(ctx, { action: 'quote', room: '1', moveIn: '2027-02-01', moveOut: '2027-02-22', paymentMethod: 'Venmo' });
  assert.strictEqual(res.transactionFee, 0);
  assert.strictEqual(res.feeWaived, true);
  assert.strictEqual(res.total, 695);
});

test('quote: feeOnDeposit=false changes the fee base (configurable, not silent)', () => {
  const ctx = fresh();
  ctx.sandbox.adminSavePricing('', { daysPerMonth: 30, feeOnDeposit: false });
  const res = getJson(ctx, { action: 'quote', room: '1', moveIn: '2027-02-01', moveOut: '2027-02-22', paymentMethod: '' });
  assert.strictEqual(res.transactionFee, 25.8); // 4% of 630+15 only
  assert.strictEqual(res.total, 720.8);
  ctx.sandbox.adminSavePricing('', { daysPerMonth: 30, feeOnDeposit: true });
  const res2 = getJson(ctx, { action: 'quote', room: '1', moveIn: '2027-02-01', moveOut: '2027-02-22', paymentMethod: '' });
  assert.strictEqual(res2.total, 722.8);
});

// --- 5. Admin auth ----------------------------------------------------------
test('admin auth: rob@controllattice.com (Google identity) is allowed without a password', () => {
  const ctx = fresh();
  ctx.state.activeEmail = 'rob@controllattice.com';
  const data = ctx.sandbox.adminData('', '2026-12');
  assert.strictEqual(data.actor, 'rob@controllattice.com');
  assert.strictEqual(data.rooms.length, 10);
  assert.strictEqual(data.rooms[0].connected, true);
  assert.strictEqual(data.rooms[0].source, 'native');
});

test('admin auth: rgh.cleveland@gmail.com is NOT auto-allowed (v5 exact-match rule); a stranger is not either', () => {
  const ctx = fresh();
  ctx.state.activeEmail = 'rgh.cleveland@gmail.com';
  assert.throws(() => ctx.sandbox.adminData('', '2026-12'), /sign-in required/);
  ctx.state.activeEmail = 'someone@example.com';
  assert.throws(() => ctx.sandbox.adminData('', '2026-12'), /sign-in required/);
});

test('admin auth: username + password flow — set (as Rob), login, use token, logout invalidates it', () => {
  const ctx = fresh();
  ctx.state.activeEmail = 'rob@controllattice.com';
  ctx.sandbox.adminSetPassword('', 'correct-horse-battery-staple-99');
  // Hash only: no plaintext password anywhere in script properties.
  const stored = Array.from(ctx.props.values()).join(' ');
  assert.ok(!stored.includes('correct-horse-battery-staple-99'));
  ctx.state.activeEmail = 'rgh.cleveland@gmail.com';
  assert.throws(() => ctx.sandbox.adminLogin('rgh.cleveland@gmail.com', 'wrong-password-here'), /Incorrect username or password/);
  assert.throws(() => ctx.sandbox.adminLogin('someone@example.com', 'correct-horse-battery-staple-99'), /Incorrect username or password/);
  assert.throws(() => ctx.sandbox.adminLogin('wrong-password-here'), /Incorrect username or password/);
  const login = ctx.sandbox.adminLogin('rgh.cleveland@gmail.com', 'correct-horse-battery-staple-99');
  assert.ok(login.token);
  const data = ctx.sandbox.adminData(login.token, '2026-12');
  assert.strictEqual(data.actor, 'rgh.cleveland@gmail.com');
  ctx.sandbox.adminLogout(login.token);
  assert.throws(() => ctx.sandbox.adminData(login.token, '2026-12'), /sign-in required/);
});

test('admin auth: username is case-insensitive (Rgh.Cleveland@Gmail.com works)', () => {
  const ctx = fresh();
  ctx.state.activeEmail = 'rob@controllattice.com';
  ctx.sandbox.adminSetPassword('', 'correct-horse-battery-staple-99');
  const login = ctx.sandbox.adminLogin('Rgh.Cleveland@Gmail.com', 'correct-horse-battery-staple-99');
  assert.ok(login.token);
});

test('admin auth: password must be at least 14 characters', () => {
  const ctx = fresh();
  assert.throws(() => ctx.sandbox.adminSetPassword('', 'short'), /at least 14/);
});

// --- 6. Calendar failure never breaks availability / bookings ---------------
test('calendar failure does not break availability', () => {
  const ctx = fresh();
  ctx.props.set('CALENDAR_ROOM_1', 'bad-cal');
  ctx.calendars['bad-cal'] = { throwOnGet: true, events: [] };
  const res = getJson(ctx, { start: '2026-12-01', end: '2027-01-01' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.rooms.find((r) => r.id === 1).blocked, [['2026-12-01', '2026-12-22']]);
});

test('admin save: calendar sync failure leaves the native reservation valid and flags retry', () => {
  const ctx = fresh();
  ctx.props.set('CALENDAR_ROOM_3', 'bad-cal');
  ctx.calendars['bad-cal'] = { throwOnGet: true, events: [] };
  const res = ctx.sandbox.adminSaveBooking('', {
    room: '3', status: 'Confirmed', moveIn: '2027-03-01', moveOut: '2027-03-22',
    name: 'Sync Test', email: 't@example.com', notes: '', paymentMethod: 'Venmo',
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.sync.ok, false);
  assert.strictEqual(res.sync.status, 'failed');
  const rows = ctx.ss._sheets['Booking Requests']._data;
  assert.ok(rows.some((r) => r[1] === res.bookingId && r[2] === 'Confirmed'));
  assert.ok(ctx.props.has('SYNC_PENDING_' + res.bookingId));
  const data = ctx.sandbox.adminData('', '2027-03');
  assert.strictEqual(data.syncPending.length, 1);
});

test('admin save: editing a booking does not clash with itself; cancellation unblocks the dates', () => {
  const ctx = fresh();
  const edited = ctx.sandbox.adminSaveBooking('', {
    id: 'RSGH-1', room: '1', status: 'Confirmed',
    moveIn: '2026-12-01', moveOut: '2026-12-22',
    name: 'Alice Adams', email: 'alice@example.com', notes: '', paymentMethod: 'Venmo',
  });
  assert.strictEqual(edited.ok, true);
  ctx.sandbox.adminSaveBooking('', {
    id: 'RSGH-1', room: '1', status: 'Cancelled',
    moveIn: '2026-12-01', moveOut: '2026-12-22',
    name: 'Alice Adams', email: 'alice@example.com', notes: '', paymentMethod: 'Venmo',
  });
  const res = getJson(ctx, { start: '2026-12-01', end: '2026-12-22' });
  assert.strictEqual(res.rooms.find((r) => r.id === 1).available, true);
  // History is intact: the row is still there, now Cancelled.
  const rows = ctx.ss._sheets['Booking Requests']._data;
  assert.ok(rows.some((r) => r[1] === 'RSGH-1' && r[2] === 'Cancelled'));
});

// --- 7. Rates / reviews ------------------------------------------------------
test('rates endpoint returns live rates from the ROOM_RATES property', () => {
  const ctx = fresh();
  const res = getJson(ctx, { action: 'rates' });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.rates, { 1: 900, 2: 750, 3: 900, 4: 900, 5: 900, 6: 750, 7: 900, 8: 925, 9: 925, 10: 925 });
  ctx.sandbox.adminSaveRate('', '2', 800);
  const res2 = getJson(ctx, { action: 'rates' });
  assert.strictEqual(res2.rates['2'], 800);
});

test('reviews endpoint returns approved reviews only, with resolved attribution and no email', () => {
  const ctx = fresh();
  const res = getJson(ctx, { action: 'reviews' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.reviews.length, 1);
  assert.strictEqual(res.reviews[0].displayName, 'Maria Lopez');
  assert.strictEqual(res.reviews[0].rating, 5);
  assert.strictEqual(res.reviews[0].email, undefined);
});

// --- 8. Calendar import (one-off, deduplicated, free/Available skipped) -----
test('adminImportCalendarEvents: dry run then import, skipping duplicates and free/Available entries', () => {
  const ctx = fresh();
  const mkEv = (id, title, start, end, transparency, creator) => ({
    getId: () => id, getTitle: () => title,
    getStartTime: () => new Date(start + 'T00:00:00'),
    getEndTime: () => new Date(end + 'T00:00:00'),
    getTransparency: () => transparency,
    getCreators: () => (creator ? [creator] : []),
  });
  ctx.props.set('CALENDAR_ROOM_1', 'cal-1');
  ctx.calendars['cal-1'] = { events: [
    mkEv('ev-dup', 'Alice Adams', '2026-12-01', '2026-12-22', 'BUSY'), // duplicate of RSGH-1
    mkEv('ev-new', 'Room 1 - Future Guest', '2027-04-01', '2027-04-22', 'BUSY'),
    // Real Google "free" transparency is "transparent", not "free".
    // Verified live example: "Room 1 - Shashwat Shrivastava",
    // 2026-05-01 to 2027-06-01, creator jrslmgt@gmail.com, transparent.
    mkEv('ev-free', 'Room 1 - Shashwat Shrivastava', '2026-05-01', '2027-06-01', 'transparent', 'jrslmgt@gmail.com'),
    mkEv('ev-free2', 'Available', '2027-05-01', '2027-05-22', 'FREE'),
  ] };
  const dry = ctx.sandbox.adminImportCalendarEvents('', { dryRun: true, monthsAhead: 12 });
  assert.strictEqual(dry.wouldImport, 1);
  assert.strictEqual(dry.skippedDuplicates, 1);
  assert.strictEqual(dry.skippedFree.length, 2);
  const shashwat = dry.skippedFree.find((e) => e.title.includes('Shashwat'));
  assert.ok(shashwat);
  assert.strictEqual(shashwat.creator, 'jrslmgt@gmail.com');
  assert.strictEqual(shashwat.transparency, 'transparent');
  const done = ctx.sandbox.adminImportCalendarEvents('', { dryRun: false, monthsAhead: 12 });
  assert.strictEqual(done.imported, 1);
  const rows = ctx.ss._sheets['Booking Requests']._data;
  const imported = rows.find((r) => r[15] === 'google-calendar-import');
  assert.ok(imported);
  assert.strictEqual(imported[2], 'Confirmed');
  assert.strictEqual(imported[4], '2027-04-01');
  assert.ok(ctx.props.has('BOOKING_EVENT_' + imported[1]));
  // Second import is a no-op for the same event (deduplicated).
  const again = ctx.sandbox.adminImportCalendarEvents('', { dryRun: false, monthsAhead: 12 });
  assert.strictEqual(again.imported, 0);
  assert.strictEqual(again.skippedDuplicates, 2);
});

// --- 9. setupBackend is safe -------------------------------------------------
test('setupBackend: missing BOOKING_SPREADSHEET_ID returns an error and creates nothing', () => {
  const ctx = fresh();
  ctx.props.delete('BOOKING_SPREADSHEET_ID');
  const res = ctx.sandbox.setupBackend();
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /BOOKING_SPREADSHEET_ID/);
});

test('setupBackend: with a configured spreadsheet it verifies headers without overwriting data', () => {
  const ctx = fresh();
  const res = ctx.sandbox.setupBackend();
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  // NOTE: arrays come from the vm realm, so compare by length, not identity.
  assert.strictEqual(res.created.length, 0);
  assert.strictEqual(res.warnings.length, 0);
  assert.strictEqual(ctx.ss._sheets['Booking Requests']._data.length, 6); // header + 5 rows
});

// --- 10. Admin dashboard HTML ------------------------------------------------
test('doGet ?action=admin returns the admin dashboard HTML', () => {
  const ctx = fresh();
  const out = ctx.sandbox.doGet({ parameter: { action: 'admin' } });
  const html = out.getContent();
  assert.ok(html.includes('Ravi\u2019s Guest House'));
  assert.ok(html.includes('Administrator sign-in'));
  assert.ok(html.includes('adminData'));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
