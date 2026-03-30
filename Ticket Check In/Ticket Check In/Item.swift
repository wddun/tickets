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
    let status: String   // "valid", "used", "invalid"
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

struct AuthUser: Codable {
    let id: String
    let email: String
}

struct AuthUserResponse: Codable {
    let user: AuthUser
}
