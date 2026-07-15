//
//  APIService.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import Foundation
import Security
import Combine
import UIKit


let baseURL = "https://tickets.willstechsupport.com"

// MARK: - Keychain Helper

private enum Keychain {
    static let service = "com.willstechsupport.Ticket-Check-In"

    static func save(_ value: String, for account: String) {
        let data = Data(value.utf8)
        let query: [CFString: Any] = [
            kSecClass:       kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        var update: [CFString: Any] = [kSecValueData: data]
        if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
            update[kSecClass]       = kSecClassGenericPassword
            update[kSecAttrService] = service
            update[kSecAttrAccount] = account
            SecItemAdd(update as CFDictionary, nil)
        }
    }

    static func load(_ account: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass:            kSecClassGenericPassword,
            kSecAttrService:      service,
            kSecAttrAccount:      account,
            kSecReturnData:       true,
            kSecMatchLimit:       kSecMatchLimitOne
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(_ account: String) {
        let query: [CFString: Any] = [
            kSecClass:       kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum APIError: Error, LocalizedError {
    case invalidURL
    case httpError(Int)
    case decodingError
    case unauthorized
    case unknown

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .httpError(let code): return "HTTP error \(code)"
        case .decodingError: return "Failed to decode response"
        case .unauthorized: return "Not logged in"
        case .unknown: return "Unknown error"
        }
    }
}

@MainActor
class APIService: ObservableObject {
    static let shared = APIService()
    private let session = URLSession.shared

    @Published var currentUser: AuthUser?
    @Published var isAuthenticated = false

    private init() {}

    // MARK: - Credential Storage (Keychain)

    private func saveCredentials(email: String, password: String) {
        Keychain.save(email,    for: "email")
        Keychain.save(password, for: "password")
    }

    private func clearCredentials() {
        Keychain.delete("email")
        Keychain.delete("password")
    }

    // MARK: - Auth

    func checkAuth() async {
        do {
            let user = try await getCurrentUser()
            currentUser = user
            isAuthenticated = true
        } catch {
            // Session expired — try auto-login with saved credentials
            if let email    = Keychain.load("email"),
               let password = Keychain.load("password") {
                do {
                    try await performLogin(email: email, password: password)
                } catch {
                    currentUser = nil
                    isAuthenticated = false
                }
            } else {
                currentUser = nil
                isAuthenticated = false
            }
        }
    }

    func login(email: String, password: String) async throws {
        try await performLogin(email: email, password: password)
        saveCredentials(email: email, password: password)
    }

    private func performLogin(email: String, password: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/auth/login") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ["email": email, "password": password]
        request.httpBody = try JSONEncoder().encode(body)

        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode != 200 { throw APIError.httpError(http.statusCode) }

        let user = try await getCurrentUser()
        currentUser = user
        isAuthenticated = true
    }

    func getCurrentUser() async throws -> AuthUser {
        guard let url = URL(string: "\(baseURL)/api/auth/me") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let response = try? JSONDecoder().decode(AuthUserResponse.self, from: data) else { throw APIError.decodingError }
        return response.user
    }

    func logout() async throws {
        guard let url = URL(string: "\(baseURL)/api/auth/logout") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        _ = try await session.data(for: request)
        currentUser = nil
        isAuthenticated = false
        clearCredentials()
    }

    func deleteAccount() async throws {
        guard let url = URL(string: "\(baseURL)/api/auth/account") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        currentUser = nil
        isAuthenticated = false
        clearCredentials()
    }

    // MARK: - Events

    func getEvents() async throws -> [Event] {
        guard let url = URL(string: "\(baseURL)/api/events") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let events = try? JSONDecoder().decode([Event].self, from: data) else { throw APIError.decodingError }
        return events
    }

    // MARK: - Scan Links (no-login scanner access)

    func resolveScannerLink(token: String) async throws -> ScannerLinkInfo {
        guard let url = URL(string: "\(baseURL)/api/scanner-links/\(token)") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let info = try? JSONDecoder().decode(ScannerLinkInfo.self, from: data) else { throw APIError.decodingError }
        return info
    }

    // MARK: - Tickets

    func getTickets(eventId: String) async throws -> [Ticket] {
        guard let url = URL(string: "\(baseURL)/api/event/\(eventId)/tickets") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let tickets = try? JSONDecoder().decode([Ticket].self, from: data) else { throw APIError.decodingError }
        return tickets
    }

    // eventId is the event currently selected on this scanner — the server
    // rejects a ticket as invalid if it actually belongs to a different event,
    // so one organizer's ticket can't be waved through at another's door.
    func validateTicket(token: String, pairToken: String? = nil, eventId: String? = nil) async throws -> ValidateResponse {
        guard let url = URL(string: "\(baseURL)/api/validate") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["token": token]
        if let pt = pairToken, !pt.isEmpty { body["pairToken"] = pt }
        if let eventId, !eventId.isEmpty { body["eventId"] = eventId }
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let result = try? JSONDecoder().decode(ValidateResponse.self, from: data) else { throw APIError.decodingError }
        return result
    }

    func checkIn(registrationId: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/checkin/\(registrationId)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    func checkInTicket(ticketId: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/checkin/\(ticketId)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    func undoCheckIn(registrationId: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/checkin/\(registrationId)") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    func confirmCheckout(token: String, pairToken: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/checkout") else { throw APIError.invalidURL }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["token": token, "pairToken": pairToken])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    func confirmCheckoutByRegistrationId(_ registrationId: String, pairToken: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/checkout") else { throw APIError.invalidURL }
        var request = URLRequest(url: url, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["registrationId": registrationId, "pairToken": pairToken])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    // MARK: - Push Notifications

    func registerPushToken(_ token: String) async throws {
        guard let url = URL(string: "\(baseURL)/api/push/register") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["token": token])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    func getPushSubscription(eventId: String) async throws -> Bool {
        guard let url = URL(string: "\(baseURL)/api/event/\(eventId)/push-subscription") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let obj = try? JSONDecoder().decode(PushSubscriptionResponse.self, from: data) else { throw APIError.decodingError }
        return obj.enabled
    }

    func setPushSubscription(eventId: String, enabled: Bool) async throws {
        guard let url = URL(string: "\(baseURL)/api/event/\(eventId)/push-subscription") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["enabled": enabled])
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
    }

    // MARK: - At-Door (in-app)

    struct AtDoorRegisterResponse: Codable {
        let ticket: Ticket?
        let name: String?
    }

    /// Issues a free ticket at the door — staff fills in name/email in the iOS app.
    func registerAtDoor(eventId: String, name: String, email: String?) async throws -> AtDoorRegisterResponse {
        guard let url = URL(string: "\(baseURL)/api/event/\(eventId)/at-door-register") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: String] = ["name": name]
        if let e = email, !e.isEmpty { body["email"] = e }
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let obj = try? JSONDecoder().decode(AtDoorRegisterResponse.self, from: data) else { throw APIError.decodingError }
        return obj
    }

    func getDisplayToken(eventId: String) async throws -> (token: String, url: String) {
        guard let url = URL(string: "\(baseURL)/api/display/token/\(eventId)") else { throw APIError.invalidURL }
        let (data, response) = try await session.data(from: url)
        guard let http = response as? HTTPURLResponse else { throw APIError.unknown }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard http.statusCode == 200 else { throw APIError.httpError(http.statusCode) }
        guard let obj = try? JSONDecoder().decode(DisplayTokenResponse.self, from: data) else { throw APIError.decodingError }
        return (obj.token, obj.url)
    }
    /// Register this scanner with the server monitor (called on launch + every 30 s).
    /// Fire-and-forget — errors are silently ignored.
    func sendHeartbeat(pairToken: String, eventId: String? = nil) async {
        guard let url = URL(string: "\(baseURL)/api/scan/heartbeat") else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let device = UIDevice.current
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        var body: [String: String] = [
            "pairToken":   pairToken,
            "platform":    "ios-app",
            "deviceName":  device.name,
            "osVersion":   "\(device.systemName) \(device.systemVersion)",
            "appVersion":  appVersion,
        ]
        if let eid = eventId { body["eventId"] = eid }
        request.httpBody = try? JSONEncoder().encode(body)
        _ = try? await session.data(for: request)
    }
}

private struct DisplayTokenResponse: Codable {
    let token: String
    let url: String
}
