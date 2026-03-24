//
//  EventsView.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import SwiftUI

// MARK: - EventsView (root)

struct EventsView: View {
    @StateObject private var api = APIService.shared

    var body: some View {
        Group {
            if api.isAuthenticated {
                EventsListView()
            } else {
                LoginView()
            }
        }
        .task { await api.checkAuth() }
    }
}

// MARK: - LoginView

struct LoginView: View {
    @StateObject private var api = APIService.shared
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()

                Image(systemName: "ticket.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Color.accentColor)

                Text("Ticket Check In")
                    .font(.title.bold())

                VStack(spacing: 16) {
                    TextField("Email", text: $email)
                        .keyboardType(.emailAddress)
                        .autocapitalization(.none)
                        .textContentType(.emailAddress)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .padding(.horizontal)

                if let error = errorMessage {
                    Text(error)
                        .foregroundStyle(.red)
                        .font(.footnote)
                }

                Button(action: login) {
                    Group {
                        if isLoading {
                            ProgressView()
                                .tint(.white)
                        } else {
                            Text("Sign In")
                                .font(.headline)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(isLoading || email.isEmpty || password.isEmpty)
                .padding(.horizontal)

                Spacer()
            }
            .navigationTitle("Sign In")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func login() {
        isLoading = true
        errorMessage = nil
        Task {
            do {
                try await api.login(email: email, password: password)
            } catch APIError.unauthorized {
                errorMessage = "Incorrect email or password."
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}

// MARK: - Events List

struct EventsListView: View {
    @StateObject private var api = APIService.shared
    @State private var events: [Event] = []
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("Loading events…")
                } else if let error = errorMessage {
                    ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if events.isEmpty {
                    ContentUnavailableView("No Events", systemImage: "calendar.badge.exclamationmark", description: Text("No events found."))
                } else {
                    List(events) { event in
                        NavigationLink(destination: AttendeesView(event: event)) {
                            EventRow(event: event)
                        }
                    }
                    .refreshable { await loadEvents() }
                }
            }
            .navigationTitle("Events")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Sign Out") {
                        Task { try? await api.logout() }
                    }
                    .foregroundStyle(.red)
                }
            }
        }
        .task { await loadEvents() }
    }

    private func loadEvents() async {
        isLoading = true
        errorMessage = nil
        do {
            events = try await api.getEvents()
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

struct EventRow: View {
    let event: Event

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(event.name)
                .font(.headline)
            if let locationName = event.location?.name {
                Text(locationName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let time = event.time, let date = ISO8601DateFormatter().date(from: time) {
                Text(date.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - Attendees List

struct AttendeesView: View {
    let event: Event
    @State private var tickets: [Ticket] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchText = ""
    @State private var checkingIn: Set<String> = []

    var filtered: [Ticket] {
        if searchText.isEmpty { return tickets }
        let q = searchText.lowercased()
        return tickets.filter {
            $0.name.lowercased().contains(q) ||
            ($0.email ?? "").lowercased().contains(q)
        }
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView("Loading attendees…")
            } else if let error = errorMessage {
                ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if tickets.isEmpty {
                ContentUnavailableView("No Attendees", systemImage: "person.slash", description: Text("No tickets found for this event."))
            } else {
                List(filtered) { ticket in
                    AttendeeRow(
                        ticket: ticket,
                        isProcessing: checkingIn.contains(ticket.registrationId),
                        onCheckIn: { checkIn(ticket: ticket) }
                    )
                }
                .searchable(text: $searchText, prompt: "Search by name or email")
                .refreshable { await loadTickets() }
            }
        }
        .navigationTitle(event.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Text("\(tickets.filter(\.isCheckedIn).count)/\(tickets.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .task { await loadTickets() }
    }

    private func loadTickets() async {
        isLoading = true
        errorMessage = nil
        do {
            tickets = try await APIService.shared.getTickets(eventId: event.id)
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func checkIn(ticket: Ticket) {
        guard !checkingIn.contains(ticket.registrationId) else { return }
        checkingIn.insert(ticket.registrationId)
        Task {
            do {
                try await APIService.shared.checkIn(registrationId: ticket.registrationId)
                // Mark all tickets with same registrationId as checked in
                let now = ISO8601DateFormatter().string(from: Date())
                for i in tickets.indices where tickets[i].registrationId == ticket.registrationId {
                    tickets[i].used_at = now
                }
                CheckInFeedback.shared.success()
            } catch {
                CheckInFeedback.shared.error()
            }
            checkingIn.remove(ticket.registrationId)
        }
    }

}

struct AttendeeRow: View {
    let ticket: Ticket
    let isProcessing: Bool
    let onCheckIn: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(ticket.name)
                    .font(.headline)
                    .strikethrough(ticket.isCheckedIn, color: .secondary)
                if let email = ticket.email {
                    Text(email)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if ticket.isCheckedIn {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.green)
            } else {
                Button(action: onCheckIn) {
                    if isProcessing {
                        ProgressView()
                            .scaleEffect(0.8)
                    } else {
                        Text("Check In")
                            .font(.caption.bold())
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.accentColor)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                }
                .disabled(isProcessing)
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 2)
    }
}
