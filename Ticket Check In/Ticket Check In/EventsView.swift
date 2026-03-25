//
//  EventsView.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import SwiftUI

// MARK: - AttendeeGroup

struct AttendeeGroup: Identifiable {
    let registrationId: String
    let name: String
    let email: String?
    var tickets: [Ticket]

    var id: String { registrationId }
    var checkedInCount: Int { tickets.filter(\.isCheckedIn).count }
    var totalCount: Int { tickets.count }
    var isFullyCheckedIn: Bool { checkedInCount == totalCount }
    var firstUncheckedTicket: Ticket? { tickets.first(where: { !$0.isCheckedIn }) }
}

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
    @State private var navigationPath = NavigationPath()
    @State private var hasAutoNavigated = false
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()

    private var lastSelectedEvent: Event? {
        guard !lastSelectedEventData.isEmpty else { return nil }
        return try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
    }

    var body: some View {
        NavigationStack(path: $navigationPath) {
            Group {
                if isLoading && events.isEmpty {
                    ProgressView("Loading events…")
                } else if let error = errorMessage {
                    ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if events.isEmpty {
                    ContentUnavailableView("No Events", systemImage: "calendar.badge.exclamationmark", description: Text("No events found."))
                } else {
                    List(events) { event in
                        Button {
                            saveLastEvent(event)
                            navigationPath.append(event)
                        } label: {
                            HStack {
                                EventRow(event: event)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.primary)
                    }
                    .refreshable { await loadEvents() }
                }
            }
            .navigationTitle("Events")
            .navigationDestination(for: Event.self) { event in
                AttendeesView(event: event)
            }
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Sign Out") {
                        Task { try? await api.logout() }
                    }
                    .foregroundStyle(.red)
                }
            }
        }
        .task {
            if !hasAutoNavigated, let lastEvent = lastSelectedEvent {
                hasAutoNavigated = true
                navigationPath.append(lastEvent)
            }
            await loadEvents()
        }
    }

    private func saveLastEvent(_ event: Event) {
        lastSelectedEventData = (try? JSONEncoder().encode(event)) ?? Data()
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

    var groups: [AttendeeGroup] {
        var dict: [String: AttendeeGroup] = [:]
        for ticket in tickets {
            if dict[ticket.registrationId] != nil {
                dict[ticket.registrationId]!.tickets.append(ticket)
            } else {
                dict[ticket.registrationId] = AttendeeGroup(
                    registrationId: ticket.registrationId,
                    name: ticket.name,
                    email: ticket.email,
                    tickets: [ticket]
                )
            }
        }
        return dict.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    var filteredGroups: [AttendeeGroup] {
        if searchText.isEmpty { return groups }
        let q = searchText.lowercased()
        return groups.filter {
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
                List(filteredGroups) { group in
                    AttendeeGroupRow(
                        group: group,
                        isProcessing: checkingIn.contains(group.registrationId),
                        onCheckInOne: { checkInOne(group: group) },
                        onCheckInAll: { checkInAll(group: group) }
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

    private func checkInOne(group: AttendeeGroup) {
        guard !checkingIn.contains(group.registrationId),
              let ticket = group.firstUncheckedTicket else { return }
        checkingIn.insert(group.registrationId)
        Task {
            do {
                try await APIService.shared.checkInTicket(ticketId: ticket.id)
                let now = ISO8601DateFormatter().string(from: Date())
                if let idx = tickets.firstIndex(where: { $0.id == ticket.id }) {
                    tickets[idx].used_at = now
                }
                CheckInFeedback.shared.success()
            } catch {
                CheckInFeedback.shared.error()
            }
            checkingIn.remove(group.registrationId)
        }
    }

    private func checkInAll(group: AttendeeGroup) {
        guard !checkingIn.contains(group.registrationId) else { return }
        checkingIn.insert(group.registrationId)
        Task {
            do {
                try await APIService.shared.checkIn(registrationId: group.registrationId)
                let now = ISO8601DateFormatter().string(from: Date())
                for i in tickets.indices where tickets[i].registrationId == group.registrationId {
                    tickets[i].used_at = now
                }
                CheckInFeedback.shared.success()
            } catch {
                CheckInFeedback.shared.error()
            }
            checkingIn.remove(group.registrationId)
        }
    }
}

struct AttendeeGroupRow: View {
    let group: AttendeeGroup
    let isProcessing: Bool
    let onCheckInOne: () -> Void
    let onCheckInAll: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                Text(group.name)
                    .font(.headline)
                    .strikethrough(group.isFullyCheckedIn, color: .secondary)
                HStack(spacing: 4) {
                    if let email = group.email {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    if group.totalCount > 1 {
                        if group.email != nil {
                            Text("·")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        Text("\(group.checkedInCount)/\(group.totalCount) tickets")
                            .font(.caption)
                            .foregroundStyle(
                                group.isFullyCheckedIn ? Color.green :
                                group.checkedInCount > 0 ? Color.orange : Color.secondary
                            )
                    }
                }
            }
            Spacer()
            if group.isFullyCheckedIn {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.green)
            } else if isProcessing {
                ProgressView()
                    .scaleEffect(0.8)
            } else {
                HStack(spacing: 6) {
                    if group.totalCount > 1 {
                        Button(action: onCheckInOne) {
                            Text("Check In 1")
                                .font(.caption.bold())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .background(Color(.systemGray5))
                                .foregroundStyle(.primary)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    Button(action: onCheckInAll) {
                        Text(group.totalCount > 1 ? "Check In All" : "Check In")
                            .font(.caption.bold())
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.accentColor)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
