/**
 * Family Expenses — Apps Script backend
 * ------------------------------------------------------------
 * A small JSON API on top of the "Family Expenses" spreadsheet.
 * The web app (GitHub Pages) talks to it with POST requests.
 *
 * How the sheet is read:
 *  - Every tab named like "OCT 26" is a month.
 *  - Columns are found by their header text (DATE OF PAYMENT, WHOM,
 *    METHOD OF PAYMENT, PAID TO, CATEGORY, DESCRIPTION, AMOUNT PAID),
 *    so older tabs without a WHOM column still work.
 *  - The category list comes from the CATEGORY dropdown in the sheet,
 *    so adding a category to the dropdown adds it to the app.
 *  - A new month tab is created automatically (copied from the latest
 *    month, data cleared) the first time you add an expense for it.
 *
 * Setup: see README.md. In short — open the spreadsheet, Extensions →
 * Apps Script, paste this file, reload the sheet, use the menu
 * "Expense App → Set app PIN…", then Deploy → New deployment → Web app
 * (Execute as: Me, Who has access: Anyone).
 */

const APP_VERSION = '1.0.0';

/** Used only if this script is not attached to the spreadsheet. */
const SPREADSHEET_ID = '17jR8P5EzYKvLPmj0XG8_AFPwMLqP_FYg3W29qVZokpc';

const MONTH_ABBR = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_FULL = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST',
  'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];
const MONTH_SHEET_RE = /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s+(\d{2})$/i;
const MONTH_TITLE_RE = /^(JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4}$/i;

/** Header text (upper case) for each field. The first match wins. */
const HEADERS = {
  date: ['DATE OF PAYMENT', 'DATE'],
  whom: ['WHOM', 'WHO'],
  method: ['METHOD OF PAYMENT', 'PAYMENT METHOD', 'METHOD'],
  paidTo: ['PAID TO', 'PAYEE'],
  category: ['CATEGORY'],
  description: ['DESCRIPTION', 'NOTES', 'NOTE'],
  amount: ['AMOUNT PAID', 'AMOUNT'],
};
const FIELDS = ['date', 'whom', 'method', 'paidTo', 'category', 'description', 'amount'];

const RECENT_MONTHS_WITH_ENTRIES = 3;   // months whose rows are sent on load
const MAX_SUMMARY_MONTHS = 24;          // months included in the trend
const DATE_FORMAT = 'dd"/"mm"/"yy';
const AMOUNT_FORMAT = '#,##0';
const MAX_FAILED_PINS = 10;             // per 15 minutes
const LOCKOUT_SECONDS = 15 * 60;
const DEDUPE_SECONDS = 6 * 60 * 60;     // remember client ids for 6 hours

// ------------------------------------------------------------------
// Web entry points
// ------------------------------------------------------------------

function doGet() {
  return json_({
    ok: true,
    app: 'family-expenses',
    version: APP_VERSION,
    message: 'The Family Expenses API is running. Open the web app and paste this URL there.',
  });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, code: 'BAD_REQUEST', error: 'The request was not valid JSON.' });
  }
  try {
    checkPin_(req.pin);
    const handler = ACTIONS[req.action];
    if (!handler) throw appError_('BAD_REQUEST', 'Unknown action "' + req.action + '".');
    const data = handler(req) || {};
    return json_(Object.assign({ ok: true, version: APP_VERSION }, data));
  } catch (err) {
    return json_({
      ok: false,
      code: err.code || 'SERVER_ERROR',
      error: err.message || String(err),
    });
  }
}

const ACTIONS = {
  ping: () => ({ pong: true }),
  bootstrap: apiBootstrap_,
  month: apiMonth_,
  add: apiAdd_,
  update: apiUpdate_,
  delete: apiDelete_,
};

// ------------------------------------------------------------------
// API actions
// ------------------------------------------------------------------

/** Everything the app needs on start: lists, month summaries, recent rows. */
function apiBootstrap_() {
  const ss = ss_();
  const months = monthSheets_(ss);
  if (!months.length) {
    throw appError_('NO_MONTHS', 'No month tabs found. Month tabs must be named like "OCT 26".');
  }
  const latest = months[months.length - 1];
  const latestLayout = layout_(latest.sheet);
  let categories = dropdownList_(latest.sheet, latestLayout, 'category') || [];
  let people = dropdownList_(latest.sheet, latestLayout, 'whom') || [];

  const summaries = [];
  const entries = {};
  const recent = [];
  const shown = months.slice(-MAX_SUMMARY_MONTHS);
  shown.forEach((m, i) => {
    const layout = layout_(m.sheet);
    const rows = readEntries_(m.sheet, layout);
    summaries.push(Object.assign(monthMeta_(m, layout), summarize_(rows)));
    if (i >= shown.length - RECENT_MONTHS_WITH_ENTRIES) {
      entries[m.name] = rows;
      Array.prototype.push.apply(recent, rows);
    }
  });

  // Fall back to values found in the data if a dropdown is missing.
  if (!categories.length) categories = distinctByCount_(recent, 'category');
  if (!people.length && latestLayout.cols.whom) people = distinctByCount_(recent, 'whom');
  const methods = distinctByCount_(recent, 'method');

  const tz = Session.getScriptTimeZone();
  return {
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    timeZone: tz,
    today: Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    categories: categories,
    people: people,
    methods: methods,
    months: summaries,
    entries: entries,
  };
}

/** Rows of one month tab, e.g. { sheet: "AUG 26" }. */
function apiMonth_(req) {
  const sheet = monthSheetByName_(ss_(), req.sheet);
  return { month: monthPayload_(sheet) };
}

/** Add one expense. The month tab is chosen from the date (and created if needed). */
function apiAdd_(req) {
  const entry = normalizeEntry_(req.entry);
  const cache = CacheService.getScriptCache();
  const cid = req.clientId ? 'cid:' + String(req.clientId).slice(0, 80) : null;

  return withLock_(() => {
    const ss = ss_();
    if (cid) {
      const previous = cache.get(cid);
      if (previous) {
        // Already saved (the phone retried after a lost response).
        const saved = JSON.parse(previous);
        return { duplicate: true, saved: saved, updated: [monthPayload_(monthSheetByName_(ss, saved.sheet))] };
      }
    }
    const target = getOrCreateMonthSheet_(ss, entry.date, false);
    const layout = layout_(target.sheet);
    validateForSheet_(target.sheet, layout, entry);
    const row = findFreeRow_(target.sheet, layout);
    writeEntry_(target.sheet, layout, row, entry);
    SpreadsheetApp.flush();
    const saved = { sheet: target.sheet.getName(), row: row };
    if (cid) cache.put(cid, JSON.stringify(saved), DEDUPE_SECONDS);
    return {
      saved: saved,
      createdSheet: target.created ? target.sheet.getName() : null,
      updated: [monthPayload_(target.sheet)],
    };
  });
}

/** Change one expense. If the date moves to another month, the row moves too. */
function apiUpdate_(req) {
  const entry = normalizeEntry_(req.entry);
  return withLock_(() => {
    const ss = ss_();
    const source = monthSheetByName_(ss, req.sheet);
    const sourceLayout = layout_(source);
    const row = Number(req.row);
    verifyRow_(source, sourceLayout, row, req.original);

    const sourceInfo = parseMonthName_(source.getName());
    if (sourceInfo.key === entry.date.slice(0, 7)) {
      validateForSheet_(source, sourceLayout, entry);
      writeEntry_(source, sourceLayout, row, entry);
      SpreadsheetApp.flush();
      return { saved: { sheet: source.getName(), row: row }, updated: [monthPayload_(source)] };
    }

    const target = getOrCreateMonthSheet_(ss, entry.date, false);
    const targetLayout = layout_(target.sheet);
    validateForSheet_(target.sheet, targetLayout, entry);
    const newRow = findFreeRow_(target.sheet, targetLayout);
    writeEntry_(target.sheet, targetLayout, newRow, entry);
    source.deleteRow(row);
    SpreadsheetApp.flush();
    return {
      saved: { sheet: target.sheet.getName(), row: newRow },
      createdSheet: target.created ? target.sheet.getName() : null,
      updated: [monthPayload_(source), monthPayload_(target.sheet)],
    };
  });
}

/** Delete one expense row (after checking it is still the same expense). */
function apiDelete_(req) {
  return withLock_(() => {
    const ss = ss_();
    const sheet = monthSheetByName_(ss, req.sheet);
    const layout = layout_(sheet);
    const row = Number(req.row);
    verifyRow_(sheet, layout, row, req.original);
    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    return { deleted: { sheet: sheet.getName(), row: row }, updated: [monthPayload_(sheet)] };
  });
}

// ------------------------------------------------------------------
// Sheet helpers
// ------------------------------------------------------------------

function ss_() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (err) { /* not bound to a spreadsheet */ }
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || SPREADSHEET_ID;
  return SpreadsheetApp.openById(id);
}

function parseMonthName_(name) {
  const m = String(name).trim().match(MONTH_SHEET_RE);
  if (!m) return null;
  const month = MONTH_ABBR.indexOf(m[1].toUpperCase()) + 1;
  const year = 2000 + Number(m[2]);
  return {
    name: String(name),
    year: year,
    month: month,
    key: year + '-' + pad2_(month),
    label: titleCase_(MONTH_FULL[month - 1]) + ' ' + year,
  };
}

/** Month tabs sorted oldest → newest. */
function monthSheets_(ss) {
  return ss.getSheets()
    .map(sheet => {
      const info = parseMonthName_(sheet.getName());
      return info ? Object.assign({ sheet: sheet }, info) : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function monthSheetByName_(ss, name) {
  const sheet = name ? ss.getSheetByName(String(name)) : null;
  if (!sheet || !parseMonthName_(sheet.getName())) {
    throw appError_('NOT_FOUND', 'There is no month tab called "' + name + '".');
  }
  return sheet;
}

/** Finds the header row and which column holds which field. */
function layout_(sheet) {
  const scanRows = Math.min(20, sheet.getMaxRows());
  const scanCols = Math.min(30, sheet.getMaxColumns());
  const values = sheet.getRange(1, 1, scanRows, scanCols).getDisplayValues();
  for (let r = 0; r < values.length; r++) {
    const cells = values[r].map(v => clean_(v).toUpperCase());
    const cols = {};
    FIELDS.forEach(field => {
      for (let h = 0; h < HEADERS[field].length && !cols[field]; h++) {
        const idx = cells.indexOf(HEADERS[field][h]);
        if (idx >= 0) cols[field] = idx + 1;
      }
    });
    if (cols.date && cols.amount && cols.category) {
      const used = Object.keys(cols).map(k => cols[k]);
      return {
        headerRow: r + 1,
        firstRow: r + 2,
        cols: cols,
        minCol: Math.min.apply(null, used),
        maxCol: Math.max.apply(null, used),
      };
    }
  }
  throw appError_('LAYOUT', 'Could not find the header row (DATE OF PAYMENT … AMOUNT PAID) on tab "' +
    sheet.getName() + '".');
}

/** Values of a dropdown (data validation list) in a column, or null. */
function dropdownList_(sheet, layout, field) {
  const col = layout.cols[field];
  if (!col) return null;
  const last = Math.min(sheet.getMaxRows(), layout.firstRow + 9);
  for (let row = layout.firstRow; row <= last; row++) {
    const rule = sheet.getRange(row, col).getDataValidation();
    if (!rule) continue;
    const type = rule.getCriteriaType();
    const args = rule.getCriteriaValues();
    const C = SpreadsheetApp.DataValidationCriteria;
    let list = null;
    if (type === C.VALUE_IN_LIST) list = args[0];
    if (type === C.VALUE_IN_RANGE) list = args[0].getValues().reduce((a, r) => a.concat(r), []);
    if (list) {
      const out = [];
      list.map(clean_).filter(String).forEach(v => { if (out.indexOf(v) < 0) out.push(v); });
      return out;
    }
  }
  return null;
}

/** Reads all expense rows of a month tab. */
function readEntries_(sheet, layout) {
  const lastRow = sheet.getLastRow();
  if (lastRow < layout.firstRow) return [];
  const width = layout.maxCol - layout.minCol + 1;
  const values = sheet.getRange(layout.firstRow, layout.minCol, lastRow - layout.firstRow + 1, width).getValues();
  const tz = sheet.getParent().getSpreadsheetTimeZone();
  const out = [];
  values.forEach((row, i) => {
    const entry = rowToEntry_(row, layout, tz);
    if (!entry) return;
    entry.row = layout.firstRow + i;
    out.push(entry);
  });
  return out;
}

function rowToEntry_(row, layout, tz) {
  const get = field => (layout.cols[field] ? row[layout.cols[field] - layout.minCol] : '');
  const date = toIsoDate_(get('date'), tz);
  const amount = toNumber_(get('amount'));
  const paidTo = clean_(get('paidTo'));
  if (!date && !amount && !paidTo) return null; // empty row
  return {
    row: 0,
    date: date,
    whom: clean_(get('whom')),
    method: clean_(get('method')),
    paidTo: paidTo,
    category: clean_(get('category')),
    description: clean_(get('description')),
    amount: amount || 0,
  };
}

/** The first empty row after the last expense (adds rows if the tab is full). */
function findFreeRow_(sheet, layout) {
  const maxRows = sheet.getMaxRows();
  const count = maxRows - layout.firstRow + 1;
  let lastUsed = layout.firstRow - 1;
  if (count > 0) {
    const width = layout.maxCol - layout.minCol + 1;
    const values = sheet.getRange(layout.firstRow, layout.minCol, count, width).getValues();
    const at = field => (layout.cols[field] ? layout.cols[field] - layout.minCol : -1);
    const keyCols = ['date', 'amount', 'paidTo', 'description'].map(at).filter(i => i >= 0);
    for (let i = values.length - 1; i >= 0; i--) {
      if (keyCols.some(c => !isBlank_(values[i][c]))) { lastUsed = layout.firstRow + i; break; }
    }
  }
  const row = lastUsed + 1;
  if (row > maxRows) sheet.insertRowsAfter(maxRows, 50);
  return row;
}

/** Writes one expense into a row, column by column run (never touches other columns). */
function writeEntry_(sheet, layout, row, entry) {
  const values = {
    date: isoToSerial_(entry.date),
    whom: entry.whom,
    method: entry.method,
    paidTo: textCell_(entry.paidTo),
    category: entry.category,
    description: textCell_(entry.description),
    amount: entry.amount,
  };
  const byCol = {};
  FIELDS.forEach(f => { if (layout.cols[f]) byCol[layout.cols[f]] = values[f]; });
  const cols = Object.keys(byCol).map(Number).sort((a, b) => a - b);
  let start = 0;
  while (start < cols.length) {
    let end = start;
    while (end + 1 < cols.length && cols[end + 1] === cols[end] + 1) end++;
    const run = cols.slice(start, end + 1).map(c => byCol[c]);
    sheet.getRange(row, cols[start], 1, run.length).setValues([run]);
    start = end + 1;
  }
  sheet.getRange(row, layout.cols.date).setNumberFormat(DATE_FORMAT);
  sheet.getRange(row, layout.cols.amount).setNumberFormat(AMOUNT_FORMAT);
}

/** Makes sure a row still holds the expense the app thinks it does. */
function verifyRow_(sheet, layout, row, original) {
  if (!row || row < layout.firstRow || row > sheet.getLastRow()) {
    throw appError_('STALE', 'That expense is no longer in the sheet. Refresh and try again.');
  }
  const width = layout.maxCol - layout.minCol + 1;
  const values = sheet.getRange(row, layout.minCol, 1, width).getValues()[0];
  const current = rowToEntry_(values, layout, sheet.getParent().getSpreadsheetTimeZone());
  const o = original || {};
  const same = current &&
    current.date === String(o.date || '') &&
    Number(current.amount) === Number(o.amount) &&
    current.paidTo.toUpperCase() === clean_(o.paidTo).toUpperCase();
  if (!same) {
    throw appError_('STALE', 'This expense was changed in the sheet. Refresh and try again.');
  }
}

/** Checks category / person against the dropdowns of the tab being written. */
function validateForSheet_(sheet, layout, entry) {
  const categories = dropdownList_(sheet, layout, 'category');
  if (categories && categories.length && categories.indexOf(entry.category) < 0) {
    throw appError_('INVALID', '"' + entry.category + '" is not in the CATEGORY dropdown on tab ' +
      sheet.getName() + '.');
  }
  if (layout.cols.whom) {
    const people = dropdownList_(sheet, layout, 'whom');
    if (people && people.length) {
      if (!entry.whom) throw appError_('INVALID', 'Choose whose expense this is.');
      if (people.indexOf(entry.whom) < 0) {
        throw appError_('INVALID', '"' + entry.whom + '" is not in the WHOM dropdown on tab ' + sheet.getName() + '.');
      }
    }
  }
}

/**
 * Returns the tab for a date's month, creating it from the latest month tab if needed.
 * `force` skips the "not too far in the past/future" guard (used by the sheet menu).
 */
function getOrCreateMonthSheet_(ss, isoDate, force) {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const key = year + '-' + pad2_(month);
  const months = monthSheets_(ss);
  const existing = months.filter(m => m.key === key)[0];
  if (existing) return { sheet: existing.sheet, created: false };
  if (!months.length) throw appError_('NO_MONTHS', 'No month tab to copy from.');

  const name = MONTH_ABBR[month - 1] + ' ' + String(year).slice(-2);
  if (!force) {
    const tz = Session.getScriptTimeZone();
    const now = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const maxKey = Utilities.formatDate(nextMonth, tz, 'yyyy-MM');
    if (key < months[0].key || key > maxKey) {
      throw appError_('INVALID', 'There is no tab "' + name + '" for that date. Check the date, or add the tab in the sheet first.');
    }
  }

  const template = months[months.length - 1].sheet;
  const sheet = template.copyTo(ss);
  sheet.setName(name);
  clearEntries_(sheet);
  setMonthTitle_(sheet, MONTH_FULL[month - 1] + ' ' + year); // e.g. "NOVEMBER 2026"

  // Keep month tabs in date order.
  const earlier = months.filter(m => m.key < key);
  const position = earlier.length
    ? earlier[earlier.length - 1].sheet.getIndex() + 1
    : months[0].sheet.getIndex();
  try {
    ss.setActiveSheet(sheet);
    ss.moveActiveSheet(position);
  } catch (err) {
    // Tab order is only cosmetic; never fail a save because of it.
  }
  return { sheet: sheet, created: true };
}

function clearEntries_(sheet) {
  const layout = layout_(sheet);
  const rows = sheet.getMaxRows() - layout.firstRow + 1;
  if (rows <= 0) return;
  const cols = FIELDS.map(f => layout.cols[f]).filter(Boolean);
  cols.forEach(col => sheet.getRange(layout.firstRow, col, rows, 1).clearContent());
}

/** Replaces the "SEPTEMBER 2026" style title near the top of a tab. */
function setMonthTitle_(sheet, title) {
  const layout = layout_(sheet);
  const rows = Math.max(1, layout.headerRow - 1);
  const cols = Math.min(30, sheet.getMaxColumns());
  const values = sheet.getRange(1, 1, rows, cols).getDisplayValues();
  for (let r = 0; r < values.length; r++) {
    for (let c = 0; c < values[r].length; c++) {
      if (MONTH_TITLE_RE.test(clean_(values[r][c]))) {
        sheet.getRange(r + 1, c + 1).setValue(title);
        return;
      }
    }
  }
}

function monthMeta_(m, layout) {
  return { name: m.name, key: m.key, label: m.label, hasWhom: !!layout.cols.whom };
}

function monthPayload_(sheet) {
  const info = parseMonthName_(sheet.getName());
  const layout = layout_(sheet);
  const rows = readEntries_(sheet, layout);
  return Object.assign(monthMeta_(info, layout), summarize_(rows), { entries: rows });
}

function summarize_(rows) {
  const byCategory = {};
  const byWhom = {};
  let total = 0;
  rows.forEach(r => {
    total += r.amount;
    if (r.category) byCategory[r.category] = (byCategory[r.category] || 0) + r.amount;
    if (r.whom) byWhom[r.whom] = (byWhom[r.whom] || 0) + r.amount;
  });
  return { total: total, count: rows.length, byCategory: byCategory, byWhom: byWhom };
}

// ------------------------------------------------------------------
// Validation, security, locking
// ------------------------------------------------------------------

function normalizeEntry_(e) {
  e = e || {};
  const date = String(e.date || '').trim();
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw appError_('INVALID', 'The date must look like 2026-10-24.');
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) {
    throw appError_('INVALID', 'That date does not exist.');
  }
  const amount = Math.round(Number(e.amount));
  if (!isFinite(amount) || amount <= 0) throw appError_('INVALID', 'The amount must be more than 0.');
  if (amount > 100000000000) throw appError_('INVALID', 'That amount is too large.');
  const up = v => clean_(v).toUpperCase().slice(0, 200);
  const out = {
    date: date,
    amount: amount,
    whom: up(e.whom),
    method: up(e.method),
    paidTo: up(e.paidTo),
    category: up(e.category),
    description: up(e.description),
  };
  if (!out.category) throw appError_('INVALID', 'Choose a category.');
  return out;
}

function checkPin_(pin) {
  const expected = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  if (!expected) {
    throw appError_('NO_PIN', 'No PIN has been set yet. In the spreadsheet, open the menu Expense App → Set app PIN.');
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pinFails') || 0);
  if (fails >= MAX_FAILED_PINS) {
    throw appError_('LOCKED', 'Too many wrong PINs. Try again in 15 minutes.');
  }
  if (String(pin || '') !== expected) {
    cache.put('pinFails', String(fails + 1), LOCKOUT_SECONDS);
    throw appError_('BAD_PIN', 'Wrong PIN.');
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw appError_('BUSY', 'The sheet is busy. Try again in a moment.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function appError_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ------------------------------------------------------------------
// Small utilities
// ------------------------------------------------------------------

function clean_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

function isBlank_(v) {
  return clean_(v) === '';
}

function pad2_(n) {
  return (Number(n) < 10 ? '0' : '') + Number(n);
}

function titleCase_(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, c => c.toUpperCase());
}

function toNumber_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const s = clean_(v);
  if (!s) return 0;
  const n = Number(s.replace(/[^\d-]/g, ''));
  return isFinite(n) ? n : 0;
}

/** Sheet date cell → "yyyy-MM-dd" (handles real dates, serials and dd/mm/yy text). */
function toIsoDate_(v, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) return serialToIso_(v);
  const s = clean_(v);
  let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (m) {
    let y = Number(m[3]);
    if (y < 100) y += 2000;
    return y + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[1] + '-' + m[2] + '-' + m[3] : '';
}

/** "2026-10-24" → spreadsheet serial day number (time-zone safe). */
function isoToSerial_(iso) {
  const y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7)), d = Number(iso.slice(8, 10));
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
}

function serialToIso_(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

/** Stops text like "=..." or "+62..." being read as a formula or number. */
function textCell_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function distinctByCount_(rows, field) {
  const counts = {};
  rows.forEach(r => { if (r[field]) counts[r[field]] = (counts[r[field]] || 0) + 1; });
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
}

// ------------------------------------------------------------------
// Spreadsheet menu
// ------------------------------------------------------------------

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Expense App')
    .addItem('Set app PIN…', 'menuSetPin')
    .addItem('Create next month tab', 'menuCreateNextMonth')
    .addSeparator()
    .addItem('Check setup', 'menuCheckSetup')
    .addToUi();
}

function menuSetPin() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt('Set app PIN',
    'Choose a PIN of 6 to 12 digits. Everyone who uses the web app types it once on their phone.',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const pin = res.getResponseText().trim();
  if (!/^\d{6,12}$/.test(pin)) {
    ui.alert('The PIN must be 6 to 12 digits. Nothing was changed.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('APP_PIN', pin);
  CacheService.getScriptCache().remove('pinFails');
  ui.alert('PIN saved. Phones that used the old PIN will ask for the new one.');
}

function menuCreateNextMonth() {
  const ui = SpreadsheetApp.getUi();
  const ss = ss_();
  const months = monthSheets_(ss);
  if (!months.length) { ui.alert('No month tabs like "OCT 26" were found.'); return; }
  const last = months[months.length - 1];
  const y = last.month === 12 ? last.year + 1 : last.year;
  const m = last.month === 12 ? 1 : last.month + 1;
  const result = withLock_(() => getOrCreateMonthSheet_(ss, y + '-' + pad2_(m) + '-01', true));
  ui.alert(result.created ? 'Created tab ' + result.sheet.getName() + '.' : 'Tab ' + result.sheet.getName() + ' already exists.');
}

function menuCheckSetup() {
  const ui = SpreadsheetApp.getUi();
  const lines = [];
  const pin = PropertiesService.getScriptProperties().getProperty('APP_PIN');
  lines.push(pin ? '✓ PIN is set.' : '✗ No PIN yet — use Expense App → Set app PIN…');
  try {
    const ss = ss_();
    const months = monthSheets_(ss);
    lines.push('✓ Month tabs: ' + months.map(m => m.name).join(', '));
    const latest = months[months.length - 1];
    const layout = layout_(latest.sheet);
    const cats = dropdownList_(latest.sheet, layout, 'category') || [];
    lines.push((cats.length ? '✓ ' : '✗ ') + 'Categories from ' + latest.name + ': ' + (cats.join(', ') || 'none found'));
    const people = dropdownList_(latest.sheet, layout, 'whom') || [];
    lines.push('✓ People: ' + (people.join(', ') || '(no WHOM dropdown)'));
  } catch (err) {
    lines.push('✗ ' + err.message);
  }
  lines.push('');
  lines.push('Next: Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone), then paste the /exec URL into the web app.');
  ui.alert('Expense App setup', lines.join('\n'), ui.ButtonSet.OK);
}
