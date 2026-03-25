//
//  APIService.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import Foundation
import Combine

let baseURL = "https://tickets.willstechsupport.com"

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
    private let defaults = UserDefaults.standard

    @Published var currentUser: AuthUser?
    @Published var isAuthenticated = false

    private init() {}

    // MARK: - Credential Storage

    private func saveCredentials(email: String, password: String) {
        defaults.set(email, forKey: "saved_email")
        defaults.set(password, forKey: "saved_password")
    }

    private func clearCredentials() {
        defaults.removeObject(forKey: "saved_email")
        defaults.removeObject(forKey: "saved_password")
    }

    // MARK: - Auth

    func checkAuth() async {
        do {
            let user = try await getCurrentUser()
            currentUser = user
            isAuthenticated = true
        } catch {
            // Session expired — try auto-login with saved credentials
            if let email = defaults.string(forKey: "saved_email"),
               let password = defaults.string(forKey: "saved_password") {
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

    func validateTicket(token: String) async throws -> ValidateResponse {
        guard let url = URL(string: "\(baseURL)/api/validate") else { throw APIError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["token": token])

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
}
