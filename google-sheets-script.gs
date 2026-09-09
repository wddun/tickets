// ============================================================
//  Ticket System — Google Sheets Script
//
//  ONE SHEET = ONE ROOM. Each event/room is its own copy of this
//  spreadsheet template, with its own trigger and its own private
//  API key — many different organizers can run their own copy
//  against the same server safely.
//
//  HOW TO SET UP (once per new room):
//  1. Open the sheet — the Event/Attendees tabs build themselves and
//     the Event Setup Wizard opens automatically.
//     Google will ask you to approve this script the first time —
//     that one-time permission prompt is required by Google for any
//     script that talks to a server, it isn't something we can skip.
//  2. Fill in the wizard (name, date, time, venue…) and submit. It
//     creates the event, turns on auto-send, and gives you a link to
//     connect the room to your account — you're done.
//
//  The Event Details rows (5–11) on the Event tab are a read-only
//  display of what the wizard last saved — there is no trigger reading
//  hand-edits there anymore, so typing into them directly does nothing
//  and won't be reflected on the server. Reopen the wizard any time
//  (Ticket System > Event Setup Wizard) to change something.
//
//  Everything else (custom fields, resending a row, duplicating this
//  sheet as a new room) lives in the menu; one-off setup helpers are
//  tucked under Ticket System > Advanced.
//
//  SETTING UP A NEW ROOM FROM THIS ONE:
//  Use Ticket System > Duplicate as New Room — don't just right-click
//  "Make a copy" in Drive, since that carries over this room's Event ID
//  and attendee data (Duplicate as New Room clears both automatically).
//
//  CUSTOM FIELDS:
//  Add any column header between "# of Tickets" and "Status" on the
//  Attendees tab to create a custom field (e.g. "T-Shirt Size", "Meal").
//  Those fields automatically appear in the email and Apple Wallet pass.
// ============================================================

// ---- Server ----
// Baked in so non-technical organizers never have to type/paste a URL.
// The Event tab's Server URL cell (B2) is an optional override — leave it
// blank to use this default.
var DEFAULT_SERVER_URL = 'https://tickets.willstechsupport.com';

// ---- Sheet tab names ----
var EVENT_SHEET_NAME     = 'Event';
var ATTENDEES_SHEET_NAME = 'Attendees';

// ---- Event sheet cell addresses ----
var EV_SERVER_URL  = 'B2';   // Server URL override (optional — see DEFAULT_SERVER_URL)
var EV_NAME        = 'B5';
var EV_DATE        = 'B6';
var EV_TIME        = 'B7';
var EV_LOCATION    = 'B8';   // Display name (e.g. "The Grand Ballroom")
var EV_ADDRESS     = 'B9';   // Full address for geocoding + lock screen
var EV_COLOR       = 'B10';
var EV_IMAGE       = 'B11';  // Google Drive file ID or share URL
var EV_EVENT_ID    = 'B14';  // Auto-filled after create
var EV_STATUS      = 'B15';  // Auto-filled after create

// ---- Attendees sheet fixed columns (1-based) ----
// Columns A–D are always fixed. Everything after "# of Tickets" and before
// "Status" is detected dynamically at runtime — don't hardcode those indices.
var COL_FIRST    = 1;  // A — always fixed
var COL_LAST     = 2;  // B — always fixed
var COL_EMAIL    = 3;  // C — always fixed
var COL_TICKETS  = 4;  // D — always fixed

var ATT_HEADER_ROW = 1;
var ATT_DATA_START = 2;

// ---- Color options (shown in dropdown) ----
var COLOR_OPTIONS = [
  'Indigo   — rgb(99, 102, 241)',
  'Purple   — rgb(139, 92, 246)',
  'Blue     — rgb(59, 130, 246)',
  'Teal     — rgb(20, 184, 166)',
  'Green    — rgb(34, 197, 94)',
  'Rose     — rgb(244, 63, 94)',
  'Orange   — rgb(249, 115, 22)',
  'Black    — rgb(17, 24, 39)',
  'Custom   — enter a color in the wizard'
];

// ============================================================
//  CUSTOM MENU (runs on open) — also auto-builds the Event/Attendees
//  tabs the very first time a fresh copy is opened. This is the one
//  piece of setup that CAN happen with zero clicks: building the two
//  tabs only touches this spreadsheet, which Google allows without
//  the user granting any permissions. Everything past that (creating
//  the event, linking the sheet) calls our server, and Google always
//  requires an explicit one-time permission prompt before a script's
//  first outside network call — that step can't be skipped or
//  automated away, so opening the wizard is the one real click left,
//  and even that we do for them automatically on a fresh copy.
// ============================================================
function onOpen() {
  var ss = SpreadsheetApp.getActive();
  var isFreshCopy = !ss.getSheetByName(EVENT_SHEET_NAME) || !ss.getSheetByName(ATTENDEES_SHEET_NAME);
  if (isFreshCopy) initializeSheet(true /* skipAlert */);

  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Ticket System')
    .addItem('Event Setup Wizard', 'openWizard')
    .addSeparator()
    .addItem('Send Pending Emails', 'sendPendingEmails')
    .addItem('Resend Selected Row', 'resendSelectedRow')
    .addItem('Refresh Scan Status', 'refreshScanStatus')
    .addSeparator()
    .addItem('Duplicate as New Room…', 'duplicateAsNewRoom')
    .addSeparator()
    .addSubMenu(ui.createMenu('Advanced')
      .addItem('Link Sheet to Account', 'linkSheetToAccount')
      .addItem('Test Connection', 'testConnection')
      .addSeparator()
      .addItem('Reset Sheet Tabs', 'initializeSheet')
      .addItem('Fix: Remove Duplicate Triggers', 'setupTriggers'))
    .addToUi();

  // A brand-new copy jumps straight into the wizard — no menu hunting,
  // no cells to find and fill in first.
  if (isFreshCopy) openWizard();
}

// Kept as a stable, separately-named entry point: it's what a Drawing
// button assigned once in the master template (Insert > Drawing, then
// right-click > Assign script > getStarted) keeps pointing at even after
// the wizard replaced the old multi-step flow underneath it.
function getStarted() {
  openWizard();
}

// ============================================================
//  SCRIPT PROPERTIES — secrets live here, never in a cell.
//  A duplicated spreadsheet gets a brand-new bound script project
//  (a fresh script ID), so these do NOT carry over on "Make a copy" —
//  that's what makes a plain Drive duplicate at least safe from
//  accidentally reusing another room's credentials.
// ============================================================
function getApiKey() {
  return PropertiesService.getScriptProperties().getProperty('API_KEY') || '';
}
function setApiKey(key) {
  if (key) PropertiesService.getScriptProperties().setProperty('API_KEY', key);
}

function getServerUrl(evSheet) {
  var override = evSheet.getRange(EV_SERVER_URL).getValue().toString().trim();
  return (override || DEFAULT_SERVER_URL).replace(/\/$/, '');
}

// ============================================================
//  EVENT SETUP WIZARD — the only supported way to create or edit
//  an event's details. A dialog with real form fields, in place of
//  filling in the Event tab's cells by hand: those cells are now a
//  read-only display (see protectEventDetailCells_), because there
//  is no longer any trigger that reads a hand-edit there and pushes
//  it to the server (see the removed onEventTabEdit) — a hand-edit
//  used to silently do nothing, which is the actual problem this
//  and the locked cells are fixing.
// ============================================================
function openWizard() {
  var ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName(EVENT_SHEET_NAME) || !ss.getSheetByName(ATTENDEES_SHEET_NAME)) {
    initializeSheet(true /* skipAlert */);
  }
  var html = HtmlService.createHtmlOutput(buildWizardHtml_())
    .setWidth(480)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Event Setup');
}

// Called by the dialog on load to pre-fill fields — blank on a fresh
// sheet, current values when reopening the wizard to change something.
function getWizardData() {
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  return {
    name:         evSheet.getRange(EV_NAME).getValue().toString(),
    date:         formatDateForInput_(evSheet.getRange(EV_DATE).getValue()),
    time:         formatTimeForInput_(evSheet.getRange(EV_TIME).getValue()),
    location:     evSheet.getRange(EV_LOCATION).getValue().toString(),
    address:      evSheet.getRange(EV_ADDRESS).getValue().toString(),
    color:        evSheet.getRange(EV_COLOR).getValue().toString() || COLOR_OPTIONS[0],
    image:        evSheet.getRange(EV_IMAGE).getValue().toString(),
    eventId:      evSheet.getRange(EV_EVENT_ID).getValue().toString().trim(),
    colorOptions: COLOR_OPTIONS
  };
}

// Called by the dialog on submit. Writes the submitted values into the
// Event Details cells (a script's own writes are unaffected by the
// warning-only protection on them either way), then creates or updates
// the event on the server. First-time creation also turns on the
// triggers and fetches a claim link, both folded into the same result so
// the dialog can show a single follow-up screen instead of chaining a
// second modal. Returns {success, error?, eventId?, created?, linkUrl?}.
function submitWizard(form) {
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);

  var dt = parseWizardDateTime_(form.date, form.time);
  evSheet.getRange(EV_NAME).setValue(form.name || '');
  evSheet.getRange(EV_DATE).setValue(dt.dateObj || '');
  evSheet.getRange(EV_TIME).setValue(dt.timeObj || '');
  evSheet.getRange(EV_LOCATION).setValue(form.location || '');
  evSheet.getRange(EV_ADDRESS).setValue(form.address || '');
  evSheet.getRange(EV_COLOR).setValue(form.color || COLOR_OPTIONS[0]);
  evSheet.getRange(EV_IMAGE).setValue(form.image || '');
  SpreadsheetApp.flush();

  var result = syncEventToServer_();
  if (!result.success) return result;

  if (result.created) {
    setupTriggers(true /* skipAlert */);
    var linkResult = fetchClaimLink_();
    result.linkUrl = linkResult.success ? linkResult.linkUrl : null;
  }
  return result;
}

// "2026-09-20" + "19:30" (native <input type="date">/<input type="time">
// values) → Date objects for the Date/Time cells. Guards against a blank
// time (defaults to midnight) since the wizard's own required-field
// validation runs client-side before this is ever called.
function parseWizardDateTime_(dateStr, timeStr) {
  if (!dateStr) return { dateObj: null, timeObj: null };
  var d = dateStr.split('-').map(Number);
  var t = (timeStr || '00:00').split(':').map(Number);
  return {
    dateObj: new Date(d[0], d[1] - 1, d[2]),
    timeObj: new Date(1899, 11, 30, t[0], t[1] || 0)
  };
}

function formatDateForInput_(val) {
  if (!val) return '';
  var d = new Date(val);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatTimeForInput_(val) {
  if (!val) return '';
  var d = new Date(val);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, Session.getScriptTimeZone(), 'HH:mm');
}

// The dialog's HTML — inline (rather than a separate .html file) to
// match how the other dialogs in this script are built.
function buildWizardHtml_() {
  return '' +
'<style>' +
'  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; padding: 18px 20px; color: #1e293b; }' +
'  h2 { font-size: 16px; margin: 0 0 14px; }' +
'  label { display: block; font-size: 12px; font-weight: 600; color: #555; margin: 12px 0 4px; }' +
'  input[type=text], input[type=date], input[type=time], select {' +
'    width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px;' +
'    border: 1px solid #ccc; border-radius: 6px; font-family: inherit;' +
'  }' +
'  .row { display: flex; gap: 10px; }' +
'  .row > div { flex: 1; }' +
'  .hint { font-size: 11px; color: #888; margin-top: 3px; }' +
'  .actions { margin-top: 20px; display: flex; gap: 8px; align-items: center; }' +
'  button { padding: 10px 16px; font-size: 14px; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; }' +
'  #submitBtn { background: #1a1f3c; color: #fff; flex: 1; }' +
'  #submitBtn:disabled { opacity: 0.5; cursor: default; }' +
'  #cancelBtn { background: #f1f2f5; color: #1a1a2e; }' +
'  .err { color: #c4294a; font-size: 13px; margin-top: 10px; display: none; }' +
'  #successView { display: none; text-align: center; padding: 20px 0; }' +
'  #successView a { display: block; margin: 16px auto 0; padding: 10px; background: #1a1f3c; color: #fff; ' +
'    border-radius: 8px; text-decoration: none; font-size: 14px; font-weight: 600; max-width: 260px; }' +
'  .status { font-size: 13px; color: #666; }' +
'</style>' +
'<div id="formView">' +
'  <h2 id="formTitle">Event Setup</h2>' +
'  <label>Event Name *</label>' +
'  <input type="text" id="f_name" placeholder="My Awesome Event">' +
'  <div class="row">' +
'    <div><label>Date *</label><input type="date" id="f_date"></div>' +
'    <div><label>Time *</label><input type="time" id="f_time"></div>' +
'  </div>' +
'  <label>Venue Name</label>' +
'  <input type="text" id="f_location" placeholder="The Grand Ballroom">' +
'  <label>Full Address</label>' +
'  <input type="text" id="f_address" placeholder="123 Main St, City, State ZIP">' +
'  <div class="hint">Used for the Apple Wallet lock-screen proximity alert.</div>' +
'  <label>Color</label>' +
'  <select id="f_color"></select>' +
'  <input type="text" id="f_colorCustom" placeholder="rgb(99, 102, 241) or #6366f1" style="display:none;margin-top:6px;">' +
'  <label>Image (Drive URL or file ID)</label>' +
'  <input type="text" id="f_image" placeholder="Paste a Google Drive share link">' +
'  <div class="hint">File must be shared "Anyone with the link".</div>' +
'  <div class="err" id="errBox"></div>' +
'  <div class="actions">' +
'    <button id="submitBtn" onclick="submitForm()">Create Event</button>' +
'    <button id="cancelBtn" onclick="google.script.host.close()">Cancel</button>' +
'    <span class="status" id="statusText"></span>' +
'  </div>' +
'</div>' +
'<div id="successView">' +
'  <h2 id="successTitle">Saved!</h2>' +
'  <p id="successMsg" class="status"></p>' +
'  <a id="claimLink" href="#" target="_blank" style="display:none;">Open Claim Link</a>' +
'  <div class="actions" style="justify-content:center;">' +
'    <button id="doneBtn" onclick="google.script.host.close()">Done</button>' +
'  </div>' +
'</div>' +
'<script>' +
'  var wizardData = null;' +
'  google.script.run.withSuccessHandler(function(data) {' +
'    wizardData = data;' +
'    document.getElementById("f_name").value = data.name || "";' +
'    document.getElementById("f_date").value = data.date || "";' +
'    document.getElementById("f_time").value = data.time || "";' +
'    document.getElementById("f_location").value = data.location || "";' +
'    document.getElementById("f_address").value = data.address || "";' +
'    document.getElementById("f_image").value = data.image || "";' +
'    var sel = document.getElementById("f_color");' +
'    sel.innerHTML = data.colorOptions.map(function(c) { return "<option>" + c + "</option>"; }).join("");' +
'    var current = data.color || data.colorOptions[0];' +
'    if (data.colorOptions.indexOf(current) === -1) {' +
'      sel.value = data.colorOptions[data.colorOptions.length - 1]; // Custom' +
'      document.getElementById("f_colorCustom").style.display = "block";' +
'      document.getElementById("f_colorCustom").value = current;' +
'    } else {' +
'      sel.value = current;' +
'    }' +
'    if (data.eventId) {' +
'      document.getElementById("formTitle").textContent = "Edit Event Details";' +
'      document.getElementById("submitBtn").textContent = "Save Changes";' +
'    }' +
'  }).getWizardData();' +
'' +
'  document.getElementById("f_color").addEventListener("change", function() {' +
'    var isCustom = this.value.indexOf("Custom") === 0;' +
'    document.getElementById("f_colorCustom").style.display = isCustom ? "block" : "none";' +
'  });' +
'' +
'  function submitForm() {' +
'    var name = document.getElementById("f_name").value.trim();' +
'    var date = document.getElementById("f_date").value;' +
'    var time = document.getElementById("f_time").value;' +
'    var errBox = document.getElementById("errBox");' +
'    if (!name || !date || !time) {' +
'      errBox.textContent = "Event Name, Date, and Time are required.";' +
'      errBox.style.display = "block";' +
'      return;' +
'    }' +
'    errBox.style.display = "none";' +
'    var colorSel = document.getElementById("f_color").value;' +
'    var color = colorSel.indexOf("Custom") === 0' +
'      ? document.getElementById("f_colorCustom").value.trim()' +
'      : colorSel;' +
'    var form = {' +
'      name: name, date: date, time: time,' +
'      location: document.getElementById("f_location").value.trim(),' +
'      address: document.getElementById("f_address").value.trim(),' +
'      color: color,' +
'      image: document.getElementById("f_image").value.trim()' +
'    };' +
'    document.getElementById("submitBtn").disabled = true;' +
'    document.getElementById("statusText").textContent = (wizardData && wizardData.eventId) ? "Saving…" : "Creating event…";' +
'    google.script.run' +
'      .withSuccessHandler(onSubmitResult)' +
'      .withFailureHandler(function(err) {' +
'        document.getElementById("submitBtn").disabled = false;' +
'        document.getElementById("statusText").textContent = "";' +
'        errBox.textContent = (err && err.message) || "Something went wrong.";' +
'        errBox.style.display = "block";' +
'      })' +
'      .submitWizard(form);' +
'  }' +
'' +
'  function onSubmitResult(result) {' +
'    document.getElementById("submitBtn").disabled = false;' +
'    document.getElementById("statusText").textContent = "";' +
'    if (!result.success) {' +
'      var errBox = document.getElementById("errBox");' +
'      errBox.textContent = result.error || "Something went wrong.";' +
'      errBox.style.display = "block";' +
'      return;' +
'    }' +
'    document.getElementById("formView").style.display = "none";' +
'    document.getElementById("successView").style.display = "block";' +
'    if (result.linkUrl) {' +
'      document.getElementById("successMsg").textContent =' +
'        "Your event is live and auto-send is on. Open this link to connect the room to your account:";' +
'      var link = document.getElementById("claimLink");' +
'      link.href = result.linkUrl;' +
'      link.style.display = "block";' +
'    } else {' +
'      document.getElementById("successMsg").textContent = "Your changes have been saved.";' +
'    }' +
'  }' +
'</script>';
}

// ============================================================
//  INITIALIZE SHEET — builds both tabs with formatting
// ============================================================
function initializeSheet(skipAlert) {
  var ss = SpreadsheetApp.getActive();

  // ---- Event tab ----
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME) || ss.insertSheet(EVENT_SHEET_NAME);
  evSheet.clear();
  evSheet.clearFormats();

  // Title
  evSheet.getRange('A1').setValue('Event Setup').setFontSize(18).setFontWeight('bold');
  evSheet.getRange('A1:D1').merge();

  // Settings section
  styleLabel(evSheet.getRange('A2'), 'Server URL (optional)');
  styleInput(evSheet.getRange('B2'), '').setNote(
    'Leave blank to use the default server (' + DEFAULT_SERVER_URL + ').\n' +
    'Only fill this in if you were told to point at a different server.'
  );

  // Divider
  evSheet.getRange('A3:D3').merge().setBackground('#4a4a8a');

  // Section header
  evSheet.getRange('A4').setValue('EVENT DETAILS').setFontWeight('bold').setFontColor('#4a4a8a').setFontSize(11);
  evSheet.getRange('A4:D4').merge();

  // Fields — display-only (see styleReadOnly): set exclusively by the
  // wizard, never by hand. No trigger reads a hand-edit here anymore, so
  // typing into them would silently do nothing, which is the actual
  // problem the wizard + this styling/protection fixes.
  var wizardNote = 'Set via Ticket System > Event Setup Wizard.\nEdits typed directly into this cell will not be saved.';
  styleLabel(evSheet.getRange('A5'), 'Event Name');
  styleReadOnly(evSheet.getRange('B5'), '').setNote(wizardNote);

  styleLabel(evSheet.getRange('A6'), 'Date');
  styleReadOnly(evSheet.getRange('B6'), '').setNumberFormat('M/d/yyyy').setNote(wizardNote);

  styleLabel(evSheet.getRange('A7'), 'Time');
  styleReadOnly(evSheet.getRange('B7'), '').setNumberFormat('h:mm am/pm').setNote(wizardNote);

  styleLabel(evSheet.getRange('A8'), 'Venue Name');
  styleReadOnly(evSheet.getRange('B8'), '').setNote(wizardNote);

  styleLabel(evSheet.getRange('A9'), 'Full Address');
  styleReadOnly(evSheet.getRange('B9'), '').setNote(wizardNote + '\n(Used for Apple Wallet lock screen proximity alert)');

  styleLabel(evSheet.getRange('A10'), 'Color');
  styleReadOnly(evSheet.getRange('B10'), COLOR_OPTIONS[0]).setNote(wizardNote);

  styleLabel(evSheet.getRange('A11'), 'Image (Drive URL/ID)');
  styleReadOnly(evSheet.getRange('B11'), '').setNote(wizardNote);

  // Warning-only: nudges anyone who tries to type directly into B5:B11
  // without blocking them (or risking locking the sheet's own owner out —
  // Sheets protections can't do that anyway, they only restrict other
  // collaborators). A script's own writes (see submitWizard_) are never
  // affected by a warning-only protection either way.
  protectEventDetailCells_(evSheet);

  // Divider
  evSheet.getRange('A12:D12').merge().setBackground('#e8e8e8');

  // Section header
  evSheet.getRange('A13').setValue('AFTER CREATING EVENT').setFontWeight('bold').setFontColor('#4a4a8a').setFontSize(11);
  evSheet.getRange('A13:D13').merge();

  styleLabel(evSheet.getRange('A14'), 'Event ID');
  evSheet.getRange('B14').setBackground('#e8f5e9').setNote('Auto-filled when you create the event');
  styleLabel(evSheet.getRange('A15'), 'Status');
  evSheet.getRange('B15').setBackground('#e8f5e9');

  // Column widths
  evSheet.setColumnWidth(1, 160);
  evSheet.setColumnWidth(2, 400);

  // ---- Attendees tab ----
  var attSheet = ss.getSheetByName(ATTENDEES_SHEET_NAME) || ss.insertSheet(ATTENDEES_SHEET_NAME);
  attSheet.clear();
  attSheet.clearFormats();

  // Headers: fixed columns, then one example custom field, then auto columns
  // To add more custom fields: insert a column between "# of Tickets" and "Status"
  var headers = ['First Name', 'Last Name', 'Email', '# of Tickets', 'T-Shirt Size', 'Status', 'Sent At', 'Ticket Tokens'];
  var headerRange = attSheet.getRange(ATT_HEADER_ROW, 1, 1, headers.length);
  headerRange.setValues([headers])
    .setFontWeight('bold')
    .setBackground('#4a4a8a')
    .setFontColor('#ffffff');
  attSheet.setFrozenRows(ATT_HEADER_ROW);

  // Mark "T-Shirt Size" as an example custom field (green header = user-editable)
  attSheet.getRange(ATT_HEADER_ROW, 5).setBackground('#2e7d32').setNote(
    'Example custom field — rename or delete this column.\n' +
    'Add more custom field columns here (between "# of Tickets" and "Status").\n' +
    'They automatically appear on tickets and Apple Wallet passes.'
  );

  // Shade auto-filled columns (Status through Ticket Tokens = cols 6–8)
  attSheet.getRange(ATT_DATA_START, 6, 500, 3)
    .setBackground('#f5f5f5')
    .setNote('Auto-filled by script — do not edit');

  // Column widths
  attSheet.setColumnWidth(1, 130);  // First Name
  attSheet.setColumnWidth(2, 130);  // Last Name
  attSheet.setColumnWidth(3, 230);  // Email
  attSheet.setColumnWidth(4, 120);  // # of Tickets
  attSheet.setColumnWidth(5, 130);  // T-Shirt Size (example custom field)
  attSheet.setColumnWidth(6, 210);  // Status
  attSheet.setColumnWidth(7, 150);  // Sent At
  attSheet.setColumnWidth(8, 340);  // Ticket Tokens

  // Bring Event tab to front
  ss.setActiveSheet(evSheet);

  if (!skipAlert) {
    SpreadsheetApp.getUi().alert(
      'Sheet initialized!\n\n' +
      'Run Ticket System > Event Setup Wizard to fill in your event details.\n\n' +
      'TIP: The green "T-Shirt Size" column is an example custom field.\n' +
      'Rename it, delete it, or add more columns between "# of Tickets" and "Status".'
    );
  }
}

// Warning-only protection on the Event Details display cells — see the
// note above where this is called from initializeSheet(). Re-applying is
// safe/idempotent: any existing protection on this exact range is removed
// first so re-running Reset Sheet Tabs doesn't stack duplicates.
function protectEventDetailCells_(evSheet) {
  var range = evSheet.getRange('B5:B11');
  evSheet.getProtections(SpreadsheetApp.ProtectionType.RANGE)
    .filter(function(p) { return p.getRange().getA1Notation() === range.getA1Notation(); })
    .forEach(function(p) { p.remove(); });
  range.protect()
    .setDescription('Event details — edit via Ticket System > Event Setup Wizard')
    .setWarningOnly(true);
}

// ============================================================
//  SYNC EVENT TO SERVER — reads the Event tab, geocodes the address,
//  and either creates the event (first time) or updates it (every
//  time after). Single source of truth for both cases so the wizard's
//  create and edit paths can't drift apart. Never touches the UI
//  directly (no ui.alert) — callers decide how to surface the result,
//  which is what lets this run from inside a dialog's submit handler.
// ============================================================
function syncEventToServer_() {
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  if (!evSheet) return { success: false, error: 'Event tab not found. Run Reset Sheet Tabs first.' };

  var serverUrl = getServerUrl(evSheet);
  var name      = evSheet.getRange(EV_NAME).getValue().toString().trim();
  var dateVal   = evSheet.getRange(EV_DATE).getValue();
  var timeVal   = evSheet.getRange(EV_TIME).getValue();
  var location  = evSheet.getRange(EV_LOCATION).getValue().toString().trim();
  var address   = evSheet.getRange(EV_ADDRESS).getValue().toString().trim();
  var colorRaw  = evSheet.getRange(EV_COLOR).getValue().toString().trim();
  var imageRef  = evSheet.getRange(EV_IMAGE).getValue().toString().trim();
  var eventId   = evSheet.getRange(EV_EVENT_ID).getValue().toString().trim();
  var apiKey    = getApiKey();

  if (!name) return { success: false, error: 'Event Name is required.' };
  if (!dateVal || !timeVal) return { success: false, error: 'Date and Time are required.' };

  // Build ISO datetime from date + time cells
  var dateObj = new Date(dateVal);
  var timeObj = new Date(timeVal);
  dateObj.setHours(timeObj.getHours(), timeObj.getMinutes(), 0, 0);
  var isoTime = dateObj.toISOString();

  // Extract color value (strip the label prefix if it's one of the presets)
  var color = colorRaw.replace(/^.*—\s*/, '').trim();
  if (!color.startsWith('rgb') && !color.startsWith('#')) {
    color = 'rgb(99, 102, 241)'; // fallback indigo
  }

  // Geocode address → lat/lng using Google's free built-in geocoder
  var lat = 0, lng = 0;
  if (address) {
    try {
      var geo = Maps.newGeocoder().geocode(address);
      if (geo.status === 'OK' && geo.results.length > 0) {
        lat = geo.results[0].geometry.location.lat;
        lng = geo.results[0].geometry.location.lng;
      }
    } catch (geoErr) {
      Logger.log('Geocode failed: ' + geoErr.message);
    }
  }

  // Just extract the Drive file ID — the server fetches the image directly
  var driveFileId = imageRef ? parseDriveFileId(imageRef) : null;

  var isCreate = !eventId;
  evSheet.getRange(EV_STATUS).setValue(isCreate ? 'Creating event...' : 'Saving changes...');
  SpreadsheetApp.flush();

  var payload = isCreate
    ? {
        name:          name,
        time:          isoTime,
        color:         color,
        locationName:  location || address,
        address:       address,
        lat:           lat,
        lng:           lng,
        // spreadsheetId is what lets the server mint this room's private
        // apiKey and tie it to this specific sheet.
        spreadsheetId: ss.getId(),
        sheetName:     name
      }
    : {
        eventId:      eventId,
        apiKey:       apiKey,
        name:         name,
        time:         isoTime,
        color:        color,
        locationName: location,
        address:      address,
        lat:          lat,
        lng:          lng
      };
  if (driveFileId) payload.driveFileId = driveFileId;

  try {
    var response = UrlFetchApp.fetch(serverUrl + (isCreate ? '/api/sheet/create-event' : '/api/sheet/update-event'), {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var result = safeParseJSON(response);

    if (result.success) {
      if (isCreate) {
        evSheet.getRange(EV_EVENT_ID).setValue(result.eventId);
        if (result.apiKey) setApiKey(result.apiKey);
      }
      evSheet.getRange(EV_STATUS).setValue(isCreate ? 'Event created! Event ID is in B14.' : 'OK: Synced');
      return { success: true, eventId: isCreate ? result.eventId : eventId, created: isCreate };
    } else {
      evSheet.getRange(EV_STATUS).setValue('Error: ' + result.error);
      return { success: false, error: result.error };
    }
  } catch (err) {
    evSheet.getRange(EV_STATUS).setValue('Error: ' + err.message);
    return { success: false, error: err.message };
  }
}

// ============================================================
//  TEST CONNECTION — pings the server with the stored apiKey before
//  anyone starts entering real attendees, so setup mistakes surface
//  immediately instead of failing silently on the first real row.
// ============================================================
function testConnection() {
  var ui      = SpreadsheetApp.getUi();
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  if (!evSheet) { ui.alert('Event tab not found. Run Reset Sheet Tabs first.'); return; }

  var serverUrl = getServerUrl(evSheet);
  var apiKey    = getApiKey();
  var eventId   = evSheet.getRange(EV_EVENT_ID).getValue().toString().trim();

  if (!eventId) { ui.alert('Create the event first (Ticket System > Event Setup Wizard).'); return; }
  if (!apiKey)  { ui.alert('No API key stored yet — run the Event Setup Wizard or Link Sheet to Account.'); return; }

  try {
    var response = UrlFetchApp.fetch(serverUrl + '/api/ticket-status', {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify({ tokens: [], spreadsheetId: ss.getId(), apiKey: apiKey }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() === 200) {
      ui.alert('Connection OK — server URL and API key are both working.');
    } else {
      var result = safeParseJSON(response);
      ui.alert('Server rejected the request:\n' + (result.error || ('HTTP ' + response.getResponseCode())));
    }
  } catch (err) {
    ui.alert('Could not reach the server:\n' + err.message);
  }
}

// ============================================================
//  DUPLICATE AS NEW ROOM — makes a Drive copy and resets the
//  copy's Event ID/Status/attendee data, since a plain spreadsheet
//  copy duplicates cell values verbatim (script properties do NOT
//  carry over — a copy gets a fresh bound script project).
// ============================================================
function duplicateAsNewRoom() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Duplicate as New Room', 'Name for the new room\'s spreadsheet:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var newName = resp.getResponseText().trim();
  if (!newName) { ui.alert('A name is required.'); return; }

  var ss  = SpreadsheetApp.getActive();
  var copyFile = DriveApp.getFileById(ss.getId()).makeCopy(newName);
  var copySs   = SpreadsheetApp.openById(copyFile.getId());

  var evSheet  = copySs.getSheetByName(EVENT_SHEET_NAME);
  var attSheet = copySs.getSheetByName(ATTENDEES_SHEET_NAME);
  if (evSheet) {
    evSheet.getRange(EV_EVENT_ID).setValue('');
    evSheet.getRange(EV_STATUS).setValue('');
  }
  if (attSheet) {
    var lastRow = attSheet.getLastRow();
    if (lastRow >= ATT_DATA_START) {
      attSheet.getRange(ATT_DATA_START, 1, lastRow - ATT_DATA_START + 1, attSheet.getLastColumn()).clearContent();
    }
  }

  var html = HtmlService.createHtmlOutput(
    '<div style="font-family: sans-serif; padding: 10px;">' +
    '<p style="font-size: 14px; margin-bottom: 12px;">New room created. Open it and run <strong>Ticket System &gt; Event Setup Wizard</strong> there — this copy\'s Event ID and attendee rows have already been cleared for you.</p>' +
    '<a href="' + copyFile.getUrl() + '" target="_blank" style="font-size:14px;">' + copyFile.getUrl() + '</a>' +
    '</div>'
  ).setWidth(480).setHeight(160);
  ui.showModalDialog(html, 'New room ready');
}

// ============================================================
//  SETUP TRIGGERS — installs installable onEdit/time-based triggers
// ============================================================
function setupTriggers(skipAlert) {
  // Remove all old managed triggers — onEventTabEdit is gone (see the
  // wizard's syncEventToServer_ above), but still listed here so a room
  // that installed it before this change gets it cleanly removed rather
  // than left behind as a dangling trigger with no function to call.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var fn = t.getHandlerFunction();
    if (fn === 'onRowComplete' || fn === 'onEventTabEdit' || fn === 'refreshScanStatus') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // Auto-send emails when attendee rows are filled in
  ScriptApp.newTrigger('onRowComplete')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  // Auto-refresh scan status every 10 minutes
  ScriptApp.newTrigger('refreshScanStatus')
    .timeBased()
    .everyMinutes(10)
    .create();

  if (!skipAlert) {
    SpreadsheetApp.getUi().alert(
      'Triggers installed!\n\n' +
      '• Emails send automatically when attendee rows are filled in\n' +
      '• Scan status refreshes every 10 minutes (skips rows already checked in)\n\n' +
      'Event details are set through the Event Setup Wizard, not the Event tab.'
    );
  }
}

// ============================================================
//  INSTALLABLE TRIGGER — fires on every sheet edit
//  Handles single edits AND autofill of multiple rows at once
// ============================================================
function onRowComplete(e) {
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== ATTENDEES_SHEET_NAME) return;

  var firstRow = e.range.getRow();
  var lastRow  = e.range.getLastRow();
  if (lastRow < ATT_DATA_START) return;
  firstRow = Math.max(firstRow, ATT_DATA_START);

  // Acquire a script-wide lock so duplicate triggers (if any) can't double-send
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch(lockErr) { return; }

  try {
  var colMap   = getColumnMap(sheet);
  var cache    = CacheService.getScriptCache();
  var ssId     = e.source.getId();

  // Get settings once up front
  var ss        = SpreadsheetApp.getActive();
  var evSheet   = ss.getSheetByName(EVENT_SHEET_NAME);
  var eventId   = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl = evSheet ? getServerUrl(evSheet) : '';
  var apiKey    = getApiKey();

  for (var row = firstRow; row <= lastRow; row++) {
    var firstName  = getCellValue(sheet, row, COL_FIRST);
    var lastName   = getCellValue(sheet, row, COL_LAST);
    var email      = getCellValue(sheet, row, COL_EMAIL);
    var ticketsRaw = getCellValue(sheet, row, COL_TICKETS);
    var status     = getCellValue(sheet, row, colMap.statusCol);

    if (!firstName || !lastName || !email || !ticketsRaw) continue;

    var ticketCount = parseTicketCount(ticketsRaw);

    // If the row was already sent and the edit was in a data column, auto-resend as an update
    if (status.indexOf('OK:') === 0) {
      // Only resend if the edit touched a data column (not status/sentAt/tokens)
      var editedCol = e.range.getColumn();
      if (editedCol >= colMap.statusCol) continue; // edited a system column, skip

      // For single-cell edits, skip if the value didn't actually change
      if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 && e.oldValue === e.value) continue;

      if (!ticketCount || !eventId || !serverUrl || !apiKey) continue;
      if (!isValidEmail(email)) { sheet.getRange(row, colMap.statusCol).setValue('Skipped: invalid email address'); continue; }

      var existingTokensStr = getCellValue(sheet, row, colMap.tokensCol);
      var tokenList = existingTokensStr
        ? existingTokensStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean)
        : [];

      // Guard against the trigger firing twice for the same edit (Google Sheets behavior)
      var cacheKey = ssId + '_r' + row + '_' + ticketCount + '_' + email;
      if (cache.get(cacheKey)) continue;
      cache.put(cacheKey, '1', 30);

      sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, apiKey, colMap, true, tokenList);
      continue;
    }

    if (status !== '') continue; // errored or other non-OK status, skip

    if (!isValidEmail(email)) {
      sheet.getRange(row, colMap.statusCol).setValue('Skipped: invalid email address');
      continue;
    }

    if (!ticketCount) {
      sheet.getRange(row, colMap.statusCol).setValue('Skipped: invalid ticket count');
      continue;
    }

    if (!eventId || !serverUrl || !apiKey) {
      sheet.getRange(row, colMap.statusCol).setValue('Skipped: create the event first (wizard)');
      continue;
    }

    var cacheKey = ssId + '_r' + row + '_' + ticketCount + '_' + email;
    if (cache.get(cacheKey)) continue;
    cache.put(cacheKey, '1', 30);

    sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, apiKey, colMap);
  }
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  sendOneRow — sends one attendee and updates status columns
//  colMap comes from getColumnMap() for dynamic column support
// ============================================================
function sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, apiKey, colMap, isResend, existingTokens) {
  sheet.getRange(row, colMap.statusCol).setValue('Sending...');
  SpreadsheetApp.flush();

  // Collect any custom field values (columns between "# of Tickets" and "Status")
  var customFields = {};
  var cfNames = Object.keys(colMap.customFields);
  for (var i = 0; i < cfNames.length; i++) {
    var fieldName = cfNames[i];
    var val = getCellValue(sheet, row, colMap.customFields[fieldName]);
    if (val) customFields[fieldName] = val;
  }

  var maxAttempts = 3;
  var lastErr = null;
  var result = null;

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        sheet.getRange(row, colMap.statusCol).setValue('Retrying (' + attempt + '/' + maxAttempts + ')...');
        SpreadsheetApp.flush();
        Utilities.sleep(2000);
      }

      var response = UrlFetchApp.fetch(serverUrl + '/api/register-bulk', {
        method:           'post',
        contentType:      'application/json',
        payload:          JSON.stringify({
          firstName:      firstName,
          lastName:       lastName,
          email:          email,
          eventId:        eventId,
          apiKey:         apiKey,
          ticketCount:    ticketCount,
          customFields:   customFields,
          resend:         isResend === true,
          existingTokens: (isResend && existingTokens && existingTokens.length) ? existingTokens : undefined
        }),
        muteHttpExceptions: true
      });

      result = safeParseJSON(response);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr) {
    sheet.getRange(row, colMap.statusCol).setValue('Error: ' + lastErr.message);
  } else if (result.success) {
    var actualCount = result.tokens.length;
    var label = actualCount + ' ticket' + (actualCount > 1 ? 's' : '');
    var statusText;
    if (result.countChanged) {
      statusText = 'OK: Updated (' + result.countChanged.from + '→' + result.countChanged.to + ' tickets)';
    } else if (isResend) {
      statusText = 'OK: Updated (' + label + ')';
    } else {
      statusText = 'OK: Sent (' + label + ')';
    }
    sheet.getRange(row, colMap.statusCol).setValue(statusText);
    sheet.getRange(row, colMap.sentAtCol).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a')
    );
    sheet.getRange(row, colMap.tokensCol).setValue(result.tokens.join(', '));
  } else {
    sheet.getRange(row, colMap.statusCol).setValue('Error: ' + result.error);
  }
}

// ============================================================
//  SEND PENDING — manually process all unfilled rows
// ============================================================
function sendPendingEmails() {
  var ss        = SpreadsheetApp.getActive();
  var evSheet   = ss.getSheetByName(EVENT_SHEET_NAME);
  var attSheet  = ss.getSheetByName(ATTENDEES_SHEET_NAME);

  if (!attSheet) {
    SpreadsheetApp.getUi().alert('Attendees tab not found. Run Initialize Sheet first.');
    return;
  }

  var eventId   = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl = evSheet ? getServerUrl(evSheet) : '';
  var apiKey    = getApiKey();

  if (!eventId || !serverUrl || !apiKey) {
    SpreadsheetApp.getUi().alert('Please create the event first (Ticket System > Event Setup Wizard).');
    return;
  }

  var colMap  = getColumnMap(attSheet);
  var lastRow = attSheet.getLastRow();
  var sent = 0, errors = 0;

  for (var row = ATT_DATA_START; row <= lastRow; row++) {
    var firstName  = getCellValue(attSheet, row, COL_FIRST);
    var lastName   = getCellValue(attSheet, row, COL_LAST);
    var email      = getCellValue(attSheet, row, COL_EMAIL);
    var ticketsRaw = getCellValue(attSheet, row, COL_TICKETS);
    var status     = getCellValue(attSheet, row, colMap.statusCol);

    if (!firstName || !lastName || !email || !ticketsRaw || status) continue;

    if (!isValidEmail(email)) {
      attSheet.getRange(row, colMap.statusCol).setValue('Skipped: invalid email address');
      errors++;
      continue;
    }

    var ticketCount = parseTicketCount(ticketsRaw);
    if (!ticketCount) continue;

    sendOneRow(attSheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, apiKey, colMap);
    var statusAfter = getCellValue(attSheet, row, colMap.statusCol);
    if (statusAfter.indexOf('OK:') === 0) sent++; else errors++;
  }

  SpreadsheetApp.getUi().alert('Done!  Sent: ' + sent + '   Errors: ' + errors);
}

// ============================================================
//  RESEND SELECTED ROW
// ============================================================
function resendSelectedRow() {
  var ss       = SpreadsheetApp.getActive();
  var sheet    = ss.getActiveSheet();
  var row      = sheet.getActiveCell().getRow();

  if (sheet.getName() !== ATTENDEES_SHEET_NAME || row < ATT_DATA_START) {
    SpreadsheetApp.getUi().alert('Please select a data row on the Attendees tab.');
    return;
  }

  var ui      = SpreadsheetApp.getUi();
  var confirm = ui.alert('Resend ticket email for row ' + row + '?', ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  var colMap     = getColumnMap(sheet);
  var evSheet    = ss.getSheetByName(EVENT_SHEET_NAME);
  var eventId    = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl  = evSheet ? getServerUrl(evSheet) : '';
  var apiKey     = getApiKey();
  var firstName  = getCellValue(sheet, row, COL_FIRST);
  var lastName   = getCellValue(sheet, row, COL_LAST);
  var email      = getCellValue(sheet, row, COL_EMAIL);
  var ticketCount = parseTicketCount(getCellValue(sheet, row, COL_TICKETS));

  if (!firstName || !lastName || !email || !ticketCount || !eventId || !serverUrl || !apiKey) {
    ui.alert('Row is missing data or Event tab is not set up.');
    return;
  }
  if (!isValidEmail(email)) { ui.alert('That email address doesn\'t look valid.'); return; }

  // Read existing tokens before clearing (to pin the resend to the right registrationId)
  var existingTokensStr = getCellValue(sheet, row, colMap.tokensCol);
  var tokenList = existingTokensStr
    ? existingTokensStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean)
    : [];
  var oldCount = tokenList.length;

  if (oldCount > 0 && oldCount !== ticketCount) {
    var countConfirm = ui.alert(
      'Ticket count changed',
      'Ticket count changed from ' + oldCount + ' to ' + ticketCount + ' for ' + email + '. Continue?',
      ui.ButtonSet.YES_NO
    );
    if (countConfirm !== ui.Button.YES) return;
  }

  // Clear status so sendOneRow will treat it as a fresh send
  sheet.getRange(row, colMap.statusCol).setValue('');
  sheet.getRange(row, colMap.sentAtCol).setValue('');
  sheet.getRange(row, colMap.tokensCol).setValue('');

  sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, apiKey, colMap, true, tokenList);

  var statusAfter = getCellValue(sheet, row, colMap.statusCol);
  if (statusAfter.indexOf('OK:') === 0) {
    ui.alert('Resent successfully!');
  } else {
    ui.alert(statusAfter);
  }
}

// ============================================================
//  REFRESH SCAN STATUS — checks each row's tokens against the server
// ============================================================
function refreshScanStatus() {
  var ss       = SpreadsheetApp.getActive();
  var evSheet  = ss.getSheetByName(EVENT_SHEET_NAME);
  var attSheet = ss.getSheetByName(ATTENDEES_SHEET_NAME);

  if (!attSheet) {
    SpreadsheetApp.getUi().alert('Attendees tab not found.');
    return;
  }

  var serverUrl = evSheet ? getServerUrl(evSheet) : '';
  var apiKey    = getApiKey();
  if (!serverUrl || !apiKey) {
    try { SpreadsheetApp.getUi().alert('Create the event first (Ticket System > Event Setup Wizard) — no API key stored yet.'); } catch (e) {}
    return;
  }

  var colMap  = getColumnMap(attSheet);
  var lastRow = attSheet.getLastRow();

  // --- Pass 1: collect all tokens and their row associations ---
  // Skip rows already in a final state to avoid unnecessary bandwidth.
  var rowTokens = {}; // row -> [token, ...]
  var allTokens = []; // flat list of every unique token

  for (var row = ATT_DATA_START; row <= lastRow; row++) {
    var tokensRaw = getCellValue(attSheet, row, colMap.tokensCol);
    if (!tokensRaw) continue;
    var tokens = tokensRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    if (!tokens.length) continue;

    // Skip rows already fully checked in — no need to poll again
    var existing = attSheet.getRange(row, colMap.statusCol).getValue().toString();
    if (existing.indexOf('Checked In (scanned)') !== -1 || existing.indexOf('manual') !== -1) continue;

    rowTokens[row] = tokens;
    tokens.forEach(function(t) { if (allTokens.indexOf(t) === -1) allTokens.push(t); });
  }

  if (!allTokens.length) {
    // Nothing pending — skip the HTTP call entirely
    try { SpreadsheetApp.getUi().alert('All rows already checked in. Nothing to update.'); } catch (e) {}
    return;
  }

  // --- Single request for all tokens ---
  var statusMap = {}; // token -> status object
  try {
    var response = UrlFetchApp.fetch(serverUrl + '/api/ticket-status', {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify({ tokens: allTokens, spreadsheetId: ss.getId(), apiKey: apiKey }),
      muteHttpExceptions: true
    });
    var statuses = safeParseJSON(response);
    if (!Array.isArray(statuses)) {
      try { SpreadsheetApp.getUi().alert('Server error: ' + (statuses.error || 'unexpected response')); } catch (e) {}
      return;
    }
    statuses.forEach(function(s) { statusMap[s.token] = s; });
  } catch (err) {
    try { SpreadsheetApp.getUi().alert('Server error: ' + err.message); } catch (e) {}
    return;
  }

  // --- Pass 2: update each row using cached results ---
  var updated = 0;
  for (var row in rowTokens) {
    var tokens = rowTokens[row];
    var cell     = attSheet.getRange(Number(row), colMap.statusCol);
    var existing = cell.getValue().toString();
    if (existing.indexOf('manual') !== -1) { updated++; continue; }

    var scannedCount = 0, total = 0;
    tokens.forEach(function(t) {
      var s = statusMap[t];
      if (!s || s.status === 'not found') return;
      total++;
      if (s.status === 'scanned') scannedCount++;
    });

    if (scannedCount === total && total > 0) {
      cell.setValue('OK: Checked In (scanned)').setBackground('#e8f5e9');
    } else if (scannedCount > 0) {
      cell.setValue('Partial: ' + scannedCount + '/' + total + ' checked in').setBackground('#fff9c4');
    }
    updated++;
  }

  // Only show alert when run manually (time-based triggers have no UI context)
  try {
    SpreadsheetApp.getUi().alert('Scan status refreshed for ' + updated + ' row(s).');
  } catch (e) { /* running as background trigger — no UI available */ }
}

// ============================================================
//  HELPERS
// ============================================================

// Returns column positions for auto-filled columns and any custom fields.
// Custom fields are any columns between "# of Tickets" and "Status" that
// have a non-empty header. This lets users add/remove custom field columns
// without touching the script.
function getColumnMap(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 9);
  var headers = sheet.getRange(ATT_HEADER_ROW, 1, 1, lastCol).getValues()[0];

  var ticketsColIdx = -1, statusColIdx = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = headers[i].toString().trim();
    if (h === '# of Tickets') ticketsColIdx = i + 1;
    if (h === 'Status')       statusColIdx  = i + 1;
  }

  // Fallback to old hardcoded layout if headers aren't found
  if (ticketsColIdx === -1) ticketsColIdx = 4;
  if (statusColIdx  === -1) statusColIdx  = 5;

  var colMap = {
    statusCol:    statusColIdx,
    sentAtCol:    statusColIdx + 1,
    tokensCol:    statusColIdx + 2,
    customFields: {}  // { "T-Shirt Size": colIndex (1-based), ... }
  };

  // Anything between # of Tickets and Status = custom field
  for (var c = ticketsColIdx + 1; c < statusColIdx; c++) {
    var hdr = headers[c - 1].toString().trim();
    if (hdr) colMap.customFields[hdr] = c;
  }

  return colMap;
}

function getCellValue(sheet, row, col) {
  return sheet.getRange(row, col).getValue().toString().trim();
}

// Simple, deliberately permissive email shape check — good enough to catch
// obvious typos ("bob@") without rejecting real addresses with unusual but
// valid formats.
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Safe JSON parse — returns null and shows a readable error if the server
// returned something other than JSON (e.g. a 502 proxy error page).
function safeParseJSON(response) {
  var code = response.getResponseCode();
  var body = response.getContentText();
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('Server returned HTTP ' + code + ': ' + body.substring(0, 120));
  }
}

// Extracts a number from "2", "2 tickets", "1 ticket", etc.
function parseTicketCount(raw) {
  var match = raw.match(/\d+/);
  if (!match) return 0;
  var n = parseInt(match[0], 10);
  return (n >= 1 && n <= 500) ? n : 0;
}

// Extracts Drive file ID from a URL or raw ID
function parseDriveFileId(ref) {
  // Already a raw ID (no slashes or http)
  if (!ref.includes('/') && !ref.includes('http')) return ref;

  // https://drive.google.com/file/d/FILE_ID/view
  var m = ref.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];

  // https://drive.google.com/open?id=FILE_ID
  var m2 = ref.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m2) return m2[1];

  return null;
}

// Helper: style a label cell
function styleLabel(range, text) {
  range.setValue(text).setFontWeight('bold').setFontColor('#333');
  return range;
}

// ============================================================
//  LINK SHEET TO ACCOUNT — generates a link URL that lets
//  anyone open it in a browser and connect this sheet's event
//  to their website account. If the room's event hasn't been
//  claimed by a real account yet, claiming it transfers real
//  ownership (not just view access) — see /api/sheet/claim.
// ============================================================
function linkSheetToAccount() {
  var ui = SpreadsheetApp.getUi();
  var result = fetchClaimLink_();

  if (!result.success) {
    ui.alert(result.error === 'no-event-tab' ? 'Event tab not found. Run Reset Sheet Tabs first.' : 'Failed to generate link:\n' + result.error);
    return;
  }

  var linkUrl = result.linkUrl;
  var htmlOutput = HtmlService.createHtmlOutput(
    '<div style="font-family: sans-serif; padding: 10px;">' +
    '<p style="font-size: 14px; margin-bottom: 12px;">Open this link and log in (or sign up) to connect this room to your account. If nobody has claimed it yet, this makes it fully yours — your own dashboard, your own settings.</p>' +
    '<a href="' + linkUrl + '" target="_blank" style="display:block;text-align:center;padding:10px;background:#1a1f3c;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin-bottom:12px;">Open Claim Link</a>' +
    '<input type="text" value="' + linkUrl + '" ' +
    'style="width: 100%; padding: 10px; font-size: 13px; border: 1px solid #ccc; border-radius: 8px;" ' +
    'onclick="this.select()" readonly>' +
    '</div>'
  )
  .setWidth(450)
  .setHeight(220);
  ui.showModalDialog(htmlOutput, 'Link This Room');
}

// Network-call portion of "link this room to an account" — pulled out so
// the wizard's own success screen can show the claim link inline instead
// of chaining a second modal dialog after the first one closes. Never
// touches the UI (no ui.alert/showModalDialog); linkSheetToAccount() above
// is the thin UI wrapper for the Advanced menu.
function fetchClaimLink_() {
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  if (!evSheet) return { success: false, error: 'no-event-tab' };

  var serverUrl = getServerUrl(evSheet);
  var eventId   = evSheet.getRange(EV_EVENT_ID).getValue().toString().trim();
  var eventName = evSheet.getRange(EV_NAME).getValue().toString().trim();
  var apiKey    = getApiKey();

  try {
    var response = UrlFetchApp.fetch(serverUrl + '/api/sheet/generate-link', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify({
        spreadsheetId: ss.getId(),
        sheetName:     eventName || ss.getName(),
        eventId:       eventId || null,
        apiKey:        apiKey
      }),
      muteHttpExceptions: true
    });
    var result = safeParseJSON(response);
    if (result.success) {
      if (result.apiKey) setApiKey(result.apiKey);
      return { success: true, linkUrl: result.linkUrl };
    }
    return { success: false, error: result.error };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Helper: style an input cell (yellow background) — still used for the
// Server URL override (B2), the one Event-tab cell still meant to be
// hand-edited.
function styleInput(range, defaultVal) {
  if (defaultVal !== undefined) range.setValue(defaultVal);
  range.setBackground('#fff9c4');
  return range;
}

// Helper: style a display-only cell (gray, not yellow) — the Event
// Details fields, set exclusively by the wizard. Same gray as the
// Attendees tab's auto-filled columns, for one consistent "don't type
// here" visual language across both tabs.
function styleReadOnly(range, defaultVal) {
  if (defaultVal !== undefined) range.setValue(defaultVal);
  range.setBackground('#f5f5f5');
  return range;
}
