//
//  Models.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import Foundation

struct Event: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let time: String?
    let color: String?
    let scannerPin: String?
    let location: EventLocation?
    let allowReentry: Bool?
    let atDoorEnabled: Bool?
    let ticketPrice: Int?   // cents; 0 or nil = free event
    let userId: String?     // owner's user id
    // Organiser-set override for how long a scan result stays full-screen —
    // wins over every scanner's own local preference when present. See
    // scanResultDurationMs in db-sqlite.js. nil means no override. var, not
    // let: ScannerView patches this in place when a settings_update SSE
    // message arrives, so a running scanner doesn't need to re-fetch the
    // whole event to pick up a live change.
    var scanResultDurationMs: Int?
    // One shared chat thread for every scanner working this event plus
    // whoever has the monitor open — off by default, toggled by an
    // organiser. var for the same live-patch reason as scanResultDurationMs.
    var roomChatEnabled: Bool?
    // Owner, admin, or a 'full' sheetAccess grant — computed server-side per
    // caller in GET /api/events. View-only collaborators can check people in
    // but can't undo it.
    let fullAccess: Bool?

    struct EventLocation: Codable, Hashable {
        let name: String?
        let address: String?
        let lat: Double?
        let lng: Double?
    }
}

struct Ticket: Codable, Identifiable {
    let id: String
    let token: String
    let registrationId: String
    let eventId: String
    let name: String
    let firstName: String?
    let lastName: String?
    let email: String?
    let customFields: [String: String]?
    let created_at: String?
    var used_at: String?

    var isCheckedIn: Bool { used_at != nil }
}

struct ValidateResponse: Codable {
    let status: String   // "valid", "used", "invalid", "reentry_exit", "reentry_enter"
    let message: String?
    let name: String?
    let firstName: String?
    let lastName: String?
    let email: String?
    let used_at: String?
    let ticketId: String?
    let registrationId: String?
    let eventName: String?
    let customFields: [String: String]?
}

/// GET /api/event/:id/metrics — everything the Stats tab shows, in one call.
///
/// Deliberately one request rather than stitching /api/events, /api/events/counts
/// and the waitlist together on the phone: at a door on a weak connection, three
/// round trips that can each half-fail is three ways for the numbers on screen to
/// disagree with each other.
struct EventMetrics: Codable {
    let eventName: String?
    let eventTime: String?
    /// Tickets that still hold a seat: issued, minus the expired and returned
    /// ones that gave theirs back. What `scanned` is measured against.
    let total: Int
    let scanned: Int
    let pct: Int
    let uniqueRegistrations: Int
    let walletDownloads: Int
    let emailOpens: Int
    let capacity: Int?
    let remaining: Int?
    let soldOut: Bool?
    /// Seats currently held by people mid-signup on the public form.
    let held: Int?
    let waitlistEnabled: Bool?
    let waiting: Int?
    let expired: Int?
    let returned: Int?
    let checkinTimeline: [CheckinBucket]?

    struct CheckinBucket: Codable, Identifiable {
        let hour: String
        let count: Int
        var id: String { hour }
    }

    var notYetIn: Int { max(0, total - scanned) }
}

struct AuthUser: Codable {
    let id: String
    let email: String
    let isAdmin: Bool?
}

struct AuthUserResponse: Codable {
    let user: AuthUser
}

struct PushSubscriptionResponse: Codable {
    let enabled: Bool
}

// Resolved from a no-login scan link (GET /api/scanner-links/:token) — locks
// the scanner to exactly one event, no account required.
struct ScannerLinkInfo: Codable {
    let eventId: String
    let eventName: String
    let color: String?
    let allowReentry: Bool?
    // var, not let — see the matching note on Event.scanResultDurationMs.
    var scanResultDurationMs: Int?
    var roomChatEnabled: Bool?
    // This link's own organiser-set label (scannerLinks.label) — lets the
    // monitor tell apart otherwise-anonymous scan-link devices, e.g. "Front
    // Gate" vs "VIP Entrance".
    let linkLabel: String?
    // Not part of the server response — set locally (see resolveScannerLink)
    // to the token this info was resolved from, then persisted alongside the
    // rest so every later validate/checkout call can prove this device holds
    // a real scan-link token for this event.
    var token: String? = nil
}

// One message in the shared per-event room chat (see roomMessages in
// db-sqlite.js) — every scanner working the event plus the monitor.
struct RoomChatMessage: Codable, Identifiable {
    let id: String
    let eventId: String
    let pairToken: String?
    let senderType: String   // "scanner" | "monitor"
    let senderName: String
    let text: String
    let createdAt: String
}

struct RoomChatMessagesResponse: Codable {
    let messages: [RoomChatMessage]
}
