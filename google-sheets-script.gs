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

// ---- Attendees sheet columns (1-based) ----
var COL_FIRST    = 1;  // A
var COL_LAST     = 2;  // B
var COL_EMAIL    = 3;  // C
var COL_TICKETS  = 4;  // D
var COL_STATUS   = 5;  // E  (auto)
var COL_SENT_AT  = 6;  // F  (auto)
var COL_TOKENS   = 7;  // G  (auto)
var COL_SCANNED  = 8;  // H  (auto — scan status)

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
  evSheet.getRange('A3').setValue('').setBackground('#4a4a8a');
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

  var headers = ['First Name', 'Last Name', 'Email', '# of Tickets', 'Status', 'Sent At', 'Ticket Tokens', 'Scan Status'];
  var headerRange = attSheet.getRange(ATT_HEADER_ROW, 1, 1, headers.length);
  headerRange.setValues([headers])
    .setFontWeight('bold')
    .setBackground('#4a4a8a')
    .setFontColor('#ffffff');
  attSheet.setFrozenRows(ATT_HEADER_ROW);

  // Shade auto-filled columns (E through H)
  attSheet.getRange(ATT_DATA_START, COL_STATUS, 500, 4)
    .setBackground('#f5f5f5')
    .setNote('Auto-filled by script — do not edit');

  attSheet.setColumnWidth(1, 130);
  attSheet.setColumnWidth(2, 130);
  attSheet.setColumnWidth(3, 230);
  attSheet.setColumnWidth(4, 120);
  attSheet.setColumnWidth(5, 210);
  attSheet.setColumnWidth(6, 150);
  attSheet.setColumnWidth(7, 340);
  attSheet.setColumnWidth(8, 150);

  // Bring Event tab to front
  ss.setActiveSheet(evSheet);

  SpreadsheetApp.getUi().alert(
    '✅ Sheet initialized!\n\n' +
    'Next steps:\n' +
    '1. Fill in your Server URL and Sheet API Key (row 2)\n' +
    '2. Fill in all Event Details (rows 5–11)\n' +
    '3. Run "Setup Triggers" from this menu\n' +
    '4. Run "Create Event from Event tab" when ready'
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

  // Fetch image from Google Drive (if provided)
  var imageBase64 = null;
  var imageExt    = null;
  if (imageRef) {
    try {
      var fileId = parseDriveFileId(imageRef);
      if (fileId) {
        var file    = DriveApp.getFileById(fileId);
        var mime    = file.getMimeType();
        var blob    = file.getBlob();
        imageBase64 = Utilities.base64Encode(blob.getBytes());
        imageExt    = mime === 'image/jpeg' ? 'jpg' : 'png';
      }
    } catch (imgErr) {
      Logger.log('Image fetch failed: ' + imgErr.message);
      SpreadsheetApp.getUi().alert(
        '⚠️ Could not fetch image from Drive: ' + imgErr.message +
        '\n\nMake sure the file is shared "Anyone with the link". Continuing without image.'
      );
    }
  }

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
  if (imageBase64) {
    payload.imageBase64 = imageBase64;
    payload.imageExt    = imageExt;
  }

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/sheet/create-event', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());

    if (result.success) {
      evSheet.getRange(EV_EVENT_ID).setValue(result.eventId);
      evSheet.getRange(EV_STATUS).setValue('✅ Event created! Event ID is in B14.');

      // Auto-set Event ID on Attendees tab if it has a settings cell (for backward compat)
      var attSheet = ss.getSheetByName(ATTENDEES_SHEET_NAME);
      if (attSheet) {
        // Store event ID in a named range so attendee trigger can read it
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
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'onRowComplete') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('onRowComplete')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onEdit()
    .create();

  SpreadsheetApp.getUi().alert(
    '✅ Triggers installed!\n\n' +
    'The Attendees tab will now auto-send emails whenever a row is fully filled in.'
  );
}

// ============================================================
//  INSTALLABLE TRIGGER — fires on every sheet edit
// ============================================================
function onRowComplete(e) {
  var sheet = e.source.getActiveSheet();
  if (sheet.getName() !== ATTENDEES_SHEET_NAME) return;

  var row = e.range.getRow();
  if (row < ATT_DATA_START) return;

  var firstName  = getCellValue(sheet, row, COL_FIRST);
  var lastName   = getCellValue(sheet, row, COL_LAST);
  var email      = getCellValue(sheet, row, COL_EMAIL);
  var ticketsRaw = getCellValue(sheet, row, COL_TICKETS);
  var status     = getCellValue(sheet, row, COL_STATUS);

  if (!firstName || !lastName || !email || !ticketsRaw) return;
  if (status !== '') return; // already processed

  var ticketCount = parseTicketCount(ticketsRaw);
  if (!ticketCount) {
    sheet.getRange(row, COL_STATUS).setValue('⚠️ Invalid ticket count');
    return;
  }

  // Get settings from Event tab
  var ss      = SpreadsheetApp.getActive();
  var evSheet = ss.getSheetByName(EVENT_SHEET_NAME);
  var eventId   = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';

  if (!eventId || !serverUrl) {
    sheet.getRange(row, COL_STATUS).setValue('⚠️ Create the event first (Event tab)');
    return;
  }

  sheet.getRange(row, COL_STATUS).setValue('⏳ Sending...');
  SpreadsheetApp.flush();

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/register-bulk', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify({
        firstName:   firstName,
        lastName:    lastName,
        email:       email,
        eventId:     eventId,
        ticketCount: ticketCount
      }),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());

    if (result.success) {
      var label = ticketCount + ' ticket' + (ticketCount > 1 ? 's' : '');
      sheet.getRange(row, COL_STATUS).setValue('✅ Sent (' + label + ')');
      sheet.getRange(row, COL_SENT_AT).setValue(
        Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a')
      );
      sheet.getRange(row, COL_TOKENS).setValue(result.tokens.join(', '));
    } else {
      sheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + result.error);
    }
  } catch (err) {
    sheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + err.message);
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

  var lastRow = attSheet.getLastRow();
  var sent = 0, errors = 0;

  for (var row = ATT_DATA_START; row <= lastRow; row++) {
    var firstName  = getCellValue(attSheet, row, COL_FIRST);
    var lastName   = getCellValue(attSheet, row, COL_LAST);
    var email      = getCellValue(attSheet, row, COL_EMAIL);
    var ticketsRaw = getCellValue(attSheet, row, COL_TICKETS);
    var status     = getCellValue(attSheet, row, COL_STATUS);

    if (!firstName || !lastName || !email || !ticketsRaw || status) continue;

    var ticketCount = parseTicketCount(ticketsRaw);
    if (!ticketCount) continue;

    attSheet.getRange(row, COL_STATUS).setValue('⏳ Sending...');
    SpreadsheetApp.flush();

    try {
      var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/register-bulk', {
        method:           'post',
        contentType:      'application/json',
        payload:          JSON.stringify({ firstName, lastName, email, eventId, ticketCount }),
        muteHttpExceptions: true
      });
      var result = JSON.parse(response.getContentText());
      if (result.success) {
        attSheet.getRange(row, COL_STATUS).setValue('✅ Sent (' + ticketCount + ' ticket' + (ticketCount > 1 ? 's' : '') + ')');
        attSheet.getRange(row, COL_SENT_AT).setValue(
          Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a')
        );
        attSheet.getRange(row, COL_TOKENS).setValue(result.tokens.join(', '));
        sent++;
      } else {
        attSheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + result.error);
        errors++;
      }
    } catch (err) {
      attSheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + err.message);
      errors++;
    }
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

  // Clear status so it will re-send
  sheet.getRange(row, COL_STATUS).setValue('');
  sheet.getRange(row, COL_SENT_AT).setValue('');
  sheet.getRange(row, COL_TOKENS).setValue('');

  var evSheet   = ss.getSheetByName(EVENT_SHEET_NAME);
  var eventId   = evSheet ? evSheet.getRange(EV_EVENT_ID).getValue().toString().trim() : '';
  var serverUrl = evSheet ? evSheet.getRange(EV_SERVER_URL).getValue().toString().trim() : '';
  var firstName  = getCellValue(sheet, row, COL_FIRST);
  var lastName   = getCellValue(sheet, row, COL_LAST);
  var email      = getCellValue(sheet, row, COL_EMAIL);
  var ticketCount = parseTicketCount(getCellValue(sheet, row, COL_TICKETS));

  if (!firstName || !lastName || !email || !ticketCount || !eventId || !serverUrl) {
    SpreadsheetApp.getUi().alert('Row is missing data or Event tab is not set up.');
    return;
  }

  sheet.getRange(row, COL_STATUS).setValue('⏳ Sending...');
  SpreadsheetApp.flush();

  try {
    var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/register-bulk', {
      method:           'post',
      contentType:      'application/json',
      payload:          JSON.stringify({ firstName, lastName, email, eventId, ticketCount }),
      muteHttpExceptions: true
    });
    var result = JSON.parse(response.getContentText());
    if (result.success) {
      sheet.getRange(row, COL_STATUS).setValue('✅ Sent (' + ticketCount + ' ticket' + (ticketCount > 1 ? 's' : '') + ')');
      sheet.getRange(row, COL_SENT_AT).setValue(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'M/d/yyyy h:mm a'));
      sheet.getRange(row, COL_TOKENS).setValue(result.tokens.join(', '));
      ui.alert('✅ Resent successfully!');
    } else {
      sheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + result.error);
      ui.alert('❌ Error: ' + result.error);
    }
  } catch (err) {
    sheet.getRange(row, COL_STATUS).setValue('❌ Error: ' + err.message);
    ui.alert('❌ Error: ' + err.message);
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

  var lastRow = attSheet.getLastRow();
  var updated = 0;

  for (var row = ATT_DATA_START; row <= lastRow; row++) {
    var tokensRaw = getCellValue(attSheet, row, COL_TOKENS);
    if (!tokensRaw) continue;

    var tokens = tokensRaw.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    if (!tokens.length) continue;

    try {
      var response = UrlFetchApp.fetch(serverUrl.replace(/\/$/, '') + '/api/ticket-status', {
        method:             'post',
        contentType:        'application/json',
        payload:            JSON.stringify({ tokens: tokens }),
        muteHttpExceptions: true
      });

      var statuses = JSON.parse(response.getContentText());
      var scannedCount = statuses.filter(function(s) { return s.status === 'scanned'; }).length;
      var total        = statuses.filter(function(s) { return s.status !== 'not found'; }).length;

      var label, bg;
      if (scannedCount === 0) {
        label = '⬜ Not scanned';
        bg    = '#ffffff';
      } else if (scannedCount < total) {
        label = '🟡 ' + scannedCount + ' / ' + total + ' scanned';
        bg    = '#fff9c4';
      } else {
        label = '✅ All scanned (' + total + ')';
        bg    = '#e8f5e9';
      }

      var cell = attSheet.getRange(row, COL_SCANNED);
      cell.setValue(label).setBackground(bg);
      updated++;
    } catch (err) {
      attSheet.getRange(row, COL_SCANNED).setValue('⚠️ Error');
    }
  }

  SpreadsheetApp.getUi().alert('Scan status refreshed for ' + updated + ' row(s).');
}

// ============================================================
//  HELPERS
// ============================================================
function getCellValue(sheet, row, col) {
  return sheet.getRange(row, col).getValue().toString().trim();
}

// Extracts a number from "2", "2 tickets", "1 ticket", etc.
function parseTicketCount(raw) {
  var match = raw.match(/\d+/);
  if (!match) return 0;
  var n = parseInt(match[0], 10);
  return (n >= 1 && n <= 20) ? n : 0;
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

// Helper: style an input cell (yellow background)
function styleInput(range, defaultVal) {
  if (defaultVal !== undefined) range.setValue(defaultVal);
  range.setBackground('#fff9c4');
  return range;
}
