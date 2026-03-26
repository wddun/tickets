// ============================================================
//  Ticket System — Google Sheets Script
//
//  HOW TO SET UP (once per template copy):
//  1. Extensions > Apps Script → paste this entire file → Save
//  2. Reload the sheet — a "🎟️ Ticket System" menu appears
//  3. Run: 🎟️ Ticket System > Initialize Sheet  (sets up tabs)
//  4. Run: 🎟️ Ticket System > Setup Triggers    (enables auto-send)
//  5. Fill in the yellow settings cells on the "Event" tab
//  6. Click "Create Event" from the menu when ready
//
//  CUSTOM FIELDS:
//  Add any column header between "# of Tickets" and "Status" on the
//  Attendees tab to create a custom field (e.g. "T-Shirt Size", "Meal").
//  Those fields automatically appear in the email and Apple Wallet pass.
// ============================================================

// ---- Sheet tab names ----
var EVENT_SHEET_NAME     = 'Event';
var ATTENDEES_SHEET_NAME = 'Attendees';

// ---- Event sheet cell addresses ----
var EV_SERVER_URL  = 'B2';   // Server URL setting
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
  'Custom   — enter rgb() or hex in B10'
];

// ============================================================
//  CUSTOM MENU (runs on open)
// ============================================================
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎟️ Ticket System')
    .addItem('Initialize Sheet (first time setup)', 'initializeSheet')
    .addItem('Setup Triggers (run once per copy)', 'setupTriggers')
    .addSeparator()
    .addItem('Create Event from Event tab', 'createEventFromSheet')
    .addSeparator()
    .addItem('Send Pending Emails', 'sendPendingEmails')
    .addItem('Resend Selected Row', 'resendSelectedRow')
    .addSeparator()
    .addItem('Refresh Scan Status', 'refreshScanStatus')
    .addSeparator()
    .addItem('Link Sheet to Account', 'linkSheetToAccount')
    .addSeparator()
    .addItem('Fix: Remove Duplicate Triggers', 'setupTriggers')
    .addToUi();
}

// ============================================================
//  INITIALIZE SHEET — builds both tabs with formatting
// ============================================================
function initializeSheet() {
  var ss = SpreadsheetApp.getActive();

  // ---- Event tab ----
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME) || ss.insertSheet(EVENT_SHEET_NAME);
  evSheet.clear();
  evSheet.clearFormats();

  // Title
  evSheet.getRange('A1').setValue('🎟️ Event Setup').setFontSize(18).setFontWeight('bold');
  evSheet.getRange('A1:D1').merge();

  // Settings section
  styleLabel(evSheet.getRange('A2'), 'Server URL');
  styleInput(evSheet.getRange('B2'), 'https://yourserver.com').setNote('Your ticket server URL — no trailing slash');

  // Divider
  evSheet.getRange('A3:D3').merge().setBackground('#4a4a8a');

  // Section header
  evSheet.getRange('A4').setValue('EVENT DETAILS').setFontWeight('bold').setFontColor('#4a4a8a').setFontSize(11);
  evSheet.getRange('A4:D4').merge();

  // Fields
  styleLabel(evSheet.getRange('A5'), 'Event Name');
  styleInput(evSheet.getRange('B5'), 'My Awesome Event');

  styleLabel(evSheet.getRange('A6'), 'Date');
  styleInput(evSheet.getRange('B6'), '').setNumberFormat('M/d/yyyy').setNote('Pick a date or type it (M/D/YYYY)');

  styleLabel(evSheet.getRange('A7'), 'Time');
  styleInput(evSheet.getRange('B7'), '').setNumberFormat('h:mm am/pm').setNote('Type the start time, e.g. 7:00 PM');

  styleLabel(evSheet.getRange('A8'), 'Venue Name');
  styleInput(evSheet.getRange('B8'), 'The Grand Ballroom');

  styleLabel(evSheet.getRange('A9'), 'Full Address');
  styleInput(evSheet.getRange('B9'), '123 Main St, City, State ZIP').setNote('Used for Apple Wallet lock screen proximity alert');

  styleLabel(evSheet.getRange('A10'), 'Color');
  var colorCell = evSheet.getRange('B10');
  styleInput(colorCell, COLOR_OPTIONS[0]);
  var colorRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(COLOR_OPTIONS, true)
    .setAllowInvalid(true)
    .build();
  colorCell.setDataValidation(colorRule);
  colorCell.setNote('Choose from list or type a custom rgb() or #hex value');

  styleLabel(evSheet.getRange('A11'), 'Image (Drive URL/ID)');
  styleInput(evSheet.getRange('B11'), '').setNote('Paste a Google Drive file URL or file ID.\nFile must be shared "Anyone with the link".');

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

  SpreadsheetApp.getUi().alert(
    '✅ Sheet initialized!\n\n' +
    'Next steps:\n' +
    '1. Fill in your Server URL (row 2)\n' +
    '2. Fill in all Event Details (rows 5–11)\n' +
    '3. Run "Setup Triggers" from this menu\n' +
    '4. Run "Create Event from Event tab" when ready\n\n' +
    'TIP: The green "T-Shirt Size" column is an example custom field.\n' +
    'Rename it, delete it, or add more columns between "# of Tickets" and "Status".'
  );
}

// ============================================================
//  CREATE EVENT — reads Event tab, geocodes, uploads image,
//  calls /api/sheet/create-event, writes back the Event ID
// ============================================================
function createEventFromSheet() {
  var ss        = SpreadsheetApp.getActive();
  var evSheet   = ss.getSheetByName(EVENT_SHEET_NAME);

  if (!evSheet) {
    SpreadsheetApp.getUi().alert('Event tab not found. Run Initialize Sheet first.');
    return;
  }

  var serverUrl = evSheet.getRange(EV_SERVER_URL).getValue().toString().trim();
  var name      = evSheet.getRange(EV_NAME).getValue().toString().trim();
  var dateVal   = evSheet.getRange(EV_DATE).getValue();
  var timeVal   = evSheet.getRange(EV_TIME).getValue();
  var location  = evSheet.getRange(EV_LOCATION).getValue().toString().trim();
  var address   = evSheet.getRange(EV_ADDRESS).getValue().toString().trim();
  var colorRaw  = evSheet.getRange(EV_COLOR).getValue().toString().trim();
  var imageRef  = evSheet.getRange(EV_IMAGE).getValue().toString().trim();

  if (!serverUrl) {
    SpreadsheetApp.getUi().alert('Please fill in your Server URL in cell B2 first.');
    return;
  }
  if (!name) {
    SpreadsheetApp.getUi().alert('Event Name (B5) is required.');
    return;
  }
  if (!dateVal || !timeVal) {
    SpreadsheetApp.getUi().alert('Date (B6) and Time (B7) are required.');
    return;
  }

  // Build ISO datetime from date + time cells
  var dateObj = new Date(dateVal);
  var timeObj = new Date(timeVal);
  dateObj.setHours(timeObj.getHours(), timeObj.getMinutes(), 0, 0);
  var isoTime = dateObj.toISOString();

  // Extract color value (strip the label prefix if they picked from dropdown)
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

  // Mark as in-progress
  evSheet.getRange(EV_STATUS).setValue('⏳ Creating event...');
  SpreadsheetApp.flush();

  // Build payload
  var payload = {
    name:        name,
    time:        isoTime,
    color:       color,
    locationName: location || address,
    address:     address,
    lat:         lat,
    lng:         lng
  };
  if (driveFileId) payload.driveFileId = driveFileId;

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/sheet/create-event', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var result = safeParseJSON(response);

    if (result.success) {
      evSheet.getRange(EV_EVENT_ID).setValue(result.eventId);
      evSheet.getRange(EV_STATUS).setValue('✅ Event created! Event ID is in B14.');

      // Store event ID in a named range so attendee trigger can read it
      var attSheet = ss.getSheetByName(ATTENDEES_SHEET_NAME);
      if (attSheet) {
        try {
          var existing = ss.getRangeByName('EVENT_ID');
          if (existing) existing.setValue(result.eventId);
        } catch(e) {}
      }

      SpreadsheetApp.getUi().alert(
        '✅ Event created!\n\n' +
        'Event ID: ' + result.eventId + '\n\n' +
        'Switch to the Attendees tab and start entering registrations. Emails will send automatically.'
      );
    } else {
      evSheet.getRange(EV_STATUS).setValue('❌ Error: ' + result.error);
      SpreadsheetApp.getUi().alert('❌ Failed to create event:\n' + result.error);
    }
  } catch (err) {
    evSheet.getRange(EV_STATUS).setValue('❌ Error: ' + err.message);
    SpreadsheetApp.getUi().alert('❌ Request failed:\n' + err.message);
  }
}

// ============================================================
//  SETUP TRIGGERS — installs installable onEdit trigger
// ============================================================
function setupTriggers() {
  // Remove all old managed triggers
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

  // Auto-sync event details when Event tab is edited
  ScriptApp.newTrigger('onEventTabEdit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  // Auto-refresh scan status every 10 minutes
  ScriptApp.newTrigger('refreshScanStatus')
    .timeBased()
    .everyMinutes(10)
    .create();

  SpreadsheetApp.getUi().alert(
    '✅ Triggers installed!\n\n' +
    '• Emails send automatically when attendee rows are filled in\n' +
    '• Event details sync to server when you edit the Event tab\n' +
    '• Scan status refreshes every 10 minutes (skips rows already checked in)'
  );
}

// ============================================================
//  EVENT TAB SYNC — auto-pushes changes to server when you
//  edit event details (name, date, time, venue, address, color, image)
// ============================================================
function onEventTabEdit(e) {
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== EVENT_SHEET_NAME) return;

  // Only react to edits in the data cells (rows 5-11)
  var row = e.range.getRow();
  if (row < 5 || row > 11) return;

  var eventId = sheet.getRange(EV_EVENT_ID).getValue().toString().trim();
  if (!eventId) return; // event not created yet — nothing to sync

  var serverUrl = sheet.getRange(EV_SERVER_URL).getValue().toString().trim();
  if (!serverUrl) return;

  // Debounce: store a flag and let a short sleep absorb rapid edits
  Utilities.sleep(800);

  // Re-read all fields fresh after the pause
  var name      = sheet.getRange(EV_NAME).getValue().toString().trim();
  var dateVal   = sheet.getRange(EV_DATE).getValue();
  var timeVal   = sheet.getRange(EV_TIME).getValue();
  var location  = sheet.getRange(EV_LOCATION).getValue().toString().trim();
  var address   = sheet.getRange(EV_ADDRESS).getValue().toString().trim();
  var colorRaw  = sheet.getRange(EV_COLOR).getValue().toString().trim();
  var imageRef  = sheet.getRange(EV_IMAGE).getValue().toString().trim();

  var color = colorRaw.replace(/^.*—\s*/, '').trim();
  if (!color.startsWith('rgb') && !color.startsWith('#')) color = '';

  // Build ISO datetime only if both date and time are set
  var isoTime = '';
  if (dateVal && timeVal) {
    try {
      var dateObj = new Date(dateVal);
      var timeObj = new Date(timeVal);
      dateObj.setHours(timeObj.getHours(), timeObj.getMinutes(), 0, 0);
      isoTime = dateObj.toISOString();
    } catch(e) {}
  }

  // Geocode address if it was the edited row
  var lat = '', lng = '';
  if (row === 9 && address) { // row 9 = address
    try {
      var geo = Maps.newGeocoder().geocode(address);
      if (geo.status === 'OK' && geo.results.length > 0) {
        lat = geo.results[0].geometry.location.lat;
        lng = geo.results[0].geometry.location.lng;
      }
    } catch(geoErr) {}
  }

  // Just extract the Drive file ID if the image cell was edited — server fetches it directly
  var driveFileId = (row === 11 && imageRef) ? parseDriveFileId(imageRef) : null;

  var payload = { eventId: eventId };
  if (name)         payload.name = name;
  if (isoTime)      payload.time = isoTime;
  if (color)        payload.color = color;
  if (location)     payload.locationName = location;
  if (address)      payload.address = address;
  if (lat !== '')   payload.lat = lat;
  if (lng !== '')   payload.lng = lng;
  if (driveFileId)  payload.driveFileId = driveFileId;

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/sheet/update-event', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var result = safeParseJSON(response);
    sheet.getRange(EV_STATUS).setValue(result.success ? '✅ Synced' : '⚠️ Sync error: ' + result.error);
  } catch (err) {
    sheet.getRange(EV_STATUS).setValue('⚠️ Sync error: ' + err.message.substring(0, 60));
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

  // Get settings once up front
  var ss        = SpreadsheetApp.getActive();
  var evSheet   = ss.getSheetByName(EVENT_SHEET_NAME);
  var eventId   = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';

  for (var row = firstRow; row <= lastRow; row++) {
    var firstName  = getCellValue(sheet, row, COL_FIRST);
    var lastName   = getCellValue(sheet, row, COL_LAST);
    var email      = getCellValue(sheet, row, COL_EMAIL);
    var ticketsRaw = getCellValue(sheet, row, COL_TICKETS);
    var status     = getCellValue(sheet, row, colMap.statusCol);

    if (!firstName || !lastName || !email || !ticketsRaw) continue;

    var ticketCount = parseTicketCount(ticketsRaw);

    // If the row was already sent and the edit was in a data column, auto-resend as an update
    if (status.indexOf('✅') === 0) {
      // Only resend if the edit touched a data column (not status/sentAt/tokens)
      var editedCol = e.range.getColumn();
      if (editedCol >= colMap.statusCol) continue; // edited a system column, skip

      // For single-cell edits, skip if the value didn't actually change
      if (e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 && e.oldValue === e.value) continue;

      if (!ticketCount || !eventId || !serverUrl) continue;

      var existingTokensStr = getCellValue(sheet, row, colMap.tokensCol);
      var tokenList = existingTokensStr
        ? existingTokensStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean)
        : [];

      // Don't clear status/sentAt/tokens here — each setValue re-triggers this function.
      // sendOneRow starts by setting "⏳ Sending..." which overwrites them anyway.
      sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, colMap, true, tokenList);
      continue;
    }

    if (status !== '') continue; // errored or other non-✅ status, skip

    if (!ticketCount) {
      sheet.getRange(row, colMap.statusCol).setValue('⚠️ Invalid ticket count');
      continue;
    }

    if (!eventId || !serverUrl) {
      sheet.getRange(row, colMap.statusCol).setValue('⚠️ Create the event first (Event tab)');
      continue;
    }

    sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, colMap);
  }
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
//  sendOneRow — sends one attendee and updates status columns
//  colMap comes from getColumnMap() for dynamic column support
// ============================================================
function sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, colMap, isResend, existingTokens) {
  sheet.getRange(row, colMap.statusCol).setValue('⏳ Sending...');
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
        sheet.getRange(row, colMap.statusCol).setValue('⏳ Retrying (' + attempt + '/' + maxAttempts + ')...');
        SpreadsheetApp.flush();
        Utilities.sleep(2000);
      }

      var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/register-bulk', {
        method:           'post',
        contentType:      'application/json',
        payload:          JSON.stringify({
          firstName:      firstName,
          lastName:       lastName,
          email:          email,
          eventId:        eventId,
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
    sheet.getRange(row, colMap.statusCol).setValue('❌ Error: ' + lastErr.message);
  } else if (result.success) {
    var actualCount = result.tokens.length;
    var label = actualCount + ' ticket' + (actualCount > 1 ? 's' : '');
    var statusText;
    if (result.countChanged) {
      statusText = '✅ Updated (' + result.countChanged.from + '→' + result.countChanged.to + ' tickets)';
    } else if (isResend) {
      statusText = '✅ Updated (' + label + ')';
    } else {
      statusText = '✅ Sent (' + label + ')';
    }
    sheet.getRange(row, colMap.statusCol).setValue(statusText);
    sheet.getRange(row, colMap.sentAtCol).setValue(
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a')
    );
    sheet.getRange(row, colMap.tokensCol).setValue(result.tokens.join(', '));
  } else {
    sheet.getRange(row, colMap.statusCol).setValue('❌ Error: ' + result.error);
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
  var serverUrl = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';

  if (!eventId || !serverUrl) {
    SpreadsheetApp.getUi().alert('Please create the event first on the Event tab.');
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

    var ticketCount = parseTicketCount(ticketsRaw);
    if (!ticketCount) continue;

    sendOneRow(attSheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, colMap);
    var statusAfter = getCellValue(attSheet, row, colMap.statusCol);
    if (statusAfter.indexOf('✅') === 0) sent++; else errors++;
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
  var serverUrl  = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';
  var firstName  = getCellValue(sheet, row, COL_FIRST);
  var lastName   = getCellValue(sheet, row, COL_LAST);
  var email      = getCellValue(sheet, row, COL_EMAIL);
  var ticketCount = parseTicketCount(getCellValue(sheet, row, COL_TICKETS));

  if (!firstName || !lastName || !email || !ticketCount || !eventId || !serverUrl) {
    SpreadsheetApp.getUi().alert('Row is missing data or Event tab is not set up.');
    return;
  }

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

  sendOneRow(sheet, row, firstName, lastName, email, ticketCount, eventId, serverUrl, colMap, true, tokenList);

  var statusAfter = getCellValue(sheet, row, colMap.statusCol);
  if (statusAfter.indexOf('✅') === 0) {
    ui.alert('✅ Resent successfully!');
  } else {
    ui.alert('❌ ' + statusAfter);
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

  var serverUrl = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';
  if (!serverUrl) {
    SpreadsheetApp.getUi().alert('Server URL not set in Event tab (B2).');
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
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/ticket-status', {
      method:             'post',
      contentType:        'application/json',
      payload:            JSON.stringify({ tokens: allTokens }),
      muteHttpExceptions: true
    });
    var statuses = safeParseJSON(response);
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
      cell.setValue('✅ Checked In (scanned)').setBackground('#e8f5e9');
    } else if (scannedCount > 0) {
      cell.setValue('🟡 ' + scannedCount + '/' + total + ' checked in').setBackground('#fff9c4');
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
    scannedCol:   statusColIdx,   // merged into Status
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
//  to their website account.
// ============================================================
function linkSheetToAccount() {
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  var ui      = SpreadsheetApp.getUi();

  if (!evSheet) {
    ui.alert('Event tab not found. Run Initialize Sheet first.');
    return;
  }

  var serverUrl = evSheet.getRange(EV_SERVER_URL).getValue().toString().trim();
  if (!serverUrl) {
    ui.alert('Please fill in your Server URL in cell B2 first.');
    return;
  }

  var eventId   = evSheet.getRange(EV_EVENT_ID).getValue().toString().trim();
  var eventName = evSheet.getRange(EV_NAME).getValue().toString().trim();
  var spreadsheetId = ss.getId();

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/sheet/generate-link', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify({
        spreadsheetId: spreadsheetId,
        sheetName:     eventName || ss.getName(),
        eventId:       eventId || null
      }),
      muteHttpExceptions: true
    });

    var result = safeParseJSON(response);

    if (result.success) {
      var linkUrl = result.linkUrl;
      var htmlOutput = HtmlService.createHtmlOutput(
        '<div style="font-family: sans-serif; padding: 10px;">' +
        '<p style="font-size: 14px; margin-bottom: 12px;">Share this link with anyone who should have access to this event on the website:</p>' +
        '<input type="text" value="' + linkUrl + '" ' +
        'style="width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 8px; margin-bottom: 12px;" ' +
        'onclick="this.select()" readonly>' +
        '<p style="font-size: 12px; color: #888;">Anyone who opens this link can create an account and link this event to their dashboard.</p>' +
        '</div>'
      )
      .setWidth(450)
      .setHeight(180);
      ui.showModalDialog(htmlOutput, '🔗 Share Event Link');
    } else {
      ui.alert('❌ Failed to generate link:\n' + result.error);
    }
  } catch (err) {
    ui.alert('❌ Request failed:\n' + err.message);
  }
}

// Helper: style an input cell (yellow background)
function styleInput(range, defaultVal) {
  if (defaultVal !== undefined) range.setValue(defaultVal);
  range.setBackground('#fff9c4');
  return range;
}
