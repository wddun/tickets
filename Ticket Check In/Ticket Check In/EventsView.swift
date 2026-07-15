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

// MARK: - EventsView

struct EventsView: View {
    var switchToScanner: () -> Void = {}
    @StateObject private var api = APIService.shared

    var body: some View {
        Group {
            if api.isAuthenticated {
                EventsListView()
            } else {
                LoginView(switchToScanner: switchToScanner)
            }
        }
        .task { await api.checkAuth() }
    }
}

// MARK: - LoginView

struct LoginView: View {
    var switchToScanner: () -> Void = {}
    @StateObject private var api = APIService.shared
    @State private var email = ""
    @State private var password = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showScanLinkSheet = false

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack { loginContent }
        } else {
            NavigationView { loginContent }
        }
    }

    @ViewBuilder
    private var loginContent: some View {
        ScrollView {
            VStack(spacing: 24) {
                Spacer().frame(height: 40)

                LogoView(size: 80)

                Text("WTS Tickets")
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

                Button("Skip — Scanner Only") {
                    switchToScanner()
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)

                Button("Have a scan link?") {
                    showScanLinkSheet = true
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)

                Text("© Will's Tech Support · support@willstechsupport.com")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                Spacer().frame(height: 40)
            }
        }
        .navigationTitle("Sign In")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $showScanLinkSheet) {
            ScanLinkEntrySheet {
                showScanLinkSheet = false
                switchToScanner()
            }
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

// MARK: - Scan Link Entry Sheet

/// Lets a device get scanner access to one event with no account at all —
/// paste the link (or just the token) an organizer shared, and it resolves
/// via the public GET /api/scanner-links/:token endpoint. Storage is shared
/// via @AppStorage so ScannerView picks up the locked event immediately.
struct ScanLinkEntrySheet: View {
    var onResolved: () -> Void = {}

    @AppStorage("scanLinkEventData")  private var scanLinkEventData: Data = Data()
    @AppStorage("scanLinkJustEntered") private var scanLinkJustEntered = false
    @Environment(\.dismiss) private var dismiss

    @State private var input = ""
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showQRScan = false

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack { sheetContent }
        } else {
            NavigationView { sheetContent }
        }
    }

    @ViewBuilder
    private var sheetContent: some View {
        VStack(spacing: 20) {
            Spacer().frame(height: 8)

            Image(systemName: "qrcode.viewfinder")
                .font(.system(size: 40))
                .foregroundStyle(Color.accentColor)

            Text("Paste the scan link an organizer sent you. This device will be able to scan tickets for that event only — no account needed.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal)

            TextField("Scan link", text: $input)
                .keyboardType(.URL)
                .autocapitalization(.none)
                .disableAutocorrection(true)
                .padding()
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal)

            if let errorMessage {
                Text(errorMessage)
                    .foregroundStyle(.red)
                    .font(.footnote)
            }

            Button(action: { resolve(input) }) {
                Group {
                    if isLoading {
                        ProgressView().tint(.white)
                    } else {
                        Text("Continue").font(.headline)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.accentColor)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(isLoading || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .padding(.horizontal)

            Button {
                showQRScan = true
            } label: {
                Label("Scan QR Instead", systemImage: "qrcode.viewfinder")
                    .font(.subheadline.weight(.semibold))
            }

            Spacer()
        }
        .padding(.top, 16)
        .navigationTitle("Scan Link")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { dismiss() }
            }
        }
        .sheet(isPresented: $showQRScan) {
            QuickScanSheet { scanned in resolve(scanned) }
        }
    }

    private func extractToken(from raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return trimmed
        }
        if let queryToken = comps.queryItems?.first(where: { $0.name == "scanToken" })?.value, !queryToken.isEmpty {
            return queryToken
        }
        let segments = comps.path.split(separator: "/")
        if comps.path.contains("/scan/"), let last = segments.last {
            return String(last)
        }
        return trimmed
    }

    private func resolve(_ raw: String) {
        let token = extractToken(from: raw)
        guard !token.isEmpty else { return }
        isLoading = true
        errorMessage = nil
        Task {
            do {
                let link = try await APIService.shared.resolveScannerLink(token: token)
                scanLinkEventData = (try? JSONEncoder().encode(link)) ?? Data()
                scanLinkJustEntered = true
                isLoading = false
                onResolved()
            } catch {
                errorMessage = "Invalid or revoked scan link."
                isLoading = false
            }
        }
    }
}

// MARK: - Events List

struct EventsListView: View {
    var body: some View {
        if #available(iOS 16, *) {
            EventsListViewModern()
        } else {
            EventsListViewLegacy()
        }
    }
}

// MARK: Events List – iOS 16+ (NavigationStack + path-based navigation)

@available(iOS 16, *)
struct EventsListViewModern: View {
    @StateObject private var api = APIService.shared
    @State private var events: [Event] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var navigationPath = NavigationPath()
    @State private var hasAutoNavigated = false
    @State private var showDeleteConfirm = false
    @State private var showDisplaySetup = false
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
                    if #available(iOS 17, *) {
                        ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                            Text("Error").font(.headline)
                            Text(error).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                } else if events.isEmpty {
                    if #available(iOS 17, *) {
                        ContentUnavailableView("No Events", systemImage: "calendar.badge.exclamationmark", description: Text("No events found."))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "calendar.badge.exclamationmark").font(.largeTitle)
                            Text("No Events").font(.headline)
                            Text("No events found.").font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
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
                    Menu {
                        Button {
                            showDisplaySetup = true
                        } label: {
                            Label("Display Setup", systemImage: "tv")
                        }
                        Divider()
                        Button("Sign Out", role: .destructive) {
                            Task { try? await api.logout() }
                        }
                        Button("Delete Account", role: .destructive) {
                            showDeleteConfirm = true
                        }
                    } label: {
                        Image(systemName: "person.circle")
                    }
                }
            }
            .confirmationDialog(
                "Delete Account",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete Account", role: .destructive) {
                    Task { try? await api.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will permanently delete your account and all associated events and tickets. This cannot be undone.")
            }
            .sheet(isPresented: $showDisplaySetup) {
                DisplaySetupView(bluetooth: BluetoothManager.shared)
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
        } catch is CancellationError {
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }
}

// MARK: Events List – iOS 15 (NavigationView + NavigationLink)

struct EventsListViewLegacy: View {
    @StateObject private var api = APIService.shared
    @State private var events: [Event] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var showDeleteConfirm = false
    @State private var showDisplaySetup = false
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()

    var body: some View {
        NavigationView {
            Group {
                if isLoading && events.isEmpty {
                    ProgressView("Loading events…")
                } else if let error = errorMessage {
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                        Text("Error").font(.headline)
                        Text(error).font(.subheadline).foregroundStyle(.secondary)
                    }
                } else if events.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "calendar.badge.exclamationmark").font(.largeTitle)
                        Text("No Events").font(.headline)
                        Text("No events found.").font(.subheadline).foregroundStyle(.secondary)
                    }
                } else {
                    List(events) { event in
                        NavigationLink(destination: AttendeesView(event: event)) {
                            EventRow(event: event)
                        }
                        .simultaneousGesture(TapGesture().onEnded { saveLastEvent(event) })
                    }
                    .refreshable { await loadEvents() }
                }
            }
            .navigationTitle("Events")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button {
                            showDisplaySetup = true
                        } label: {
                            Label("Display Setup", systemImage: "tv")
                        }
                        Divider()
                        Button("Sign Out", role: .destructive) {
                            Task { try? await api.logout() }
                        }
                        Button("Delete Account", role: .destructive) {
                            showDeleteConfirm = true
                        }
                    } label: {
                        Image(systemName: "person.circle")
                    }
                }
            }
            .confirmationDialog(
                "Delete Account",
                isPresented: $showDeleteConfirm,
                titleVisibility: .visible
            ) {
                Button("Delete Account", role: .destructive) {
                    Task { try? await api.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This will permanently delete your account and all associated events and tickets. This cannot be undone.")
            }
            .sheet(isPresented: $showDisplaySetup) {
                DisplaySetupView(bluetooth: BluetoothManager.shared)
            }
        }
        .task { await loadEvents() }
    }

    private func saveLastEvent(_ event: Event) {
        lastSelectedEventData = (try? JSONEncoder().encode(event)) ?? Data()
    }

    private func loadEvents() async {
        isLoading = true
        errorMessage = nil
        do {
            events = try await api.getEvents()
        } catch is CancellationError {
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
    @StateObject private var api = APIService.shared
    @State private var tickets: [Ticket] = []
    @State private var isLoading = false
    @State private var errorMessage: String?
    @State private var searchText = ""
    @State private var checkingIn: Set<String> = []
    @State private var refreshTimer: Timer?
    @State private var pickerGroup: AttendeeGroup? = nil
    @State private var showNotifSettings = false
    @State private var pushEnabled: Bool = false
    @State private var pushLoading = true
    @State private var pushError: String? = nil
    @State private var selectedTab: AttendeesTab = .attendees

    enum AttendeesTab: Hashable { case attendees, atDoor }

    private var canUndo: Bool { api.currentUser?.isAdmin == true }
    private var atDoorEnabled: Bool { event.atDoorEnabled == true }

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
        return dict.values.sorted {
            if $0.isFullyCheckedIn != $1.isFullyCheckedIn {
                return !$0.isFullyCheckedIn
            }
            return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
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
        VStack(spacing: 0) {
            if atDoorEnabled {
                Picker("", selection: $selectedTab) {
                    Text("Attendees").tag(AttendeesTab.attendees)
                    Text("At Door").tag(AttendeesTab.atDoor)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top, 8)
            }

            if selectedTab == .atDoor && atDoorEnabled {
                AtDoorView(event: event)
            } else {
                attendeesContent
            }
        }
        .navigationTitle(event.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button {
                    showNotifSettings = true
                } label: {
                    Image(systemName: pushEnabled ? "bell.fill" : "bell")
                }
                .accessibilityLabel("Notification Settings")
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                let checked = tickets.filter(\.isCheckedIn).count
                let total = tickets.count
                let allDone = total > 0 && checked == total
                Text("\(checked) / \(total)")
                    .font(.system(size: 16, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundColor(allDone ? .green : .primary)
                    .fixedSize()
                    .allowsHitTesting(false)
            }
        }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            refreshTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in
                Task { await loadTickets(showSpinner: false) }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            refreshTimer?.invalidate()
            refreshTimer = nil
        }
        .task { await loadTickets() }
        .task { await loadPushSetting() }
        .sheet(isPresented: $showNotifSettings) {
            NotificationSettingsSheet(
                eventName: event.name,
                enabled: pushEnabled,
                isLoading: pushLoading,
                errorMessage: pushError,
                onToggle: { newValue in
                    Task { await togglePush(newValue) }
                }
            )
        }
    }

    @ViewBuilder
    private var attendeesContent: some View {
        if isLoading {
            ProgressView("Loading attendees…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = errorMessage {
            if #available(iOS 17, *) {
                ContentUnavailableView("Error", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle)
                    Text("Error").font(.headline)
                    Text(error).font(.subheadline).foregroundStyle(.secondary)
                }
            }
        } else if tickets.isEmpty {
            if #available(iOS 17, *) {
                ContentUnavailableView("No Attendees", systemImage: "person.slash", description: Text("No tickets found for this event."))
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "person.slash").font(.largeTitle)
                    Text("No Attendees").font(.headline)
                    Text("No tickets found for this event.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
        } else {
            List(filteredGroups) { group in
                AttendeeGroupRow(
                    group: group,
                    isProcessing: checkingIn.contains(group.registrationId),
                    canUndo: canUndo,
                    onCheckInOne: { pickerGroup = group },
                    onCheckInAll: { checkInAll(group: group) },
                    onUndo: { undoGroup(group: group) }
                )
            }
            .animation(.none, value: searchText)
            .searchable(text: $searchText, prompt: "Search by name or email")
            .refreshable { await loadTickets() }
            .sheet(item: $pickerGroup) { group in
                TicketPickerSheet(group: group) { selectedIds in
                    pickerGroup = nil
                    checkInSelected(group: group, ticketIds: selectedIds)
                }
            }
        }
    }

    private func loadTickets(showSpinner: Bool = true) async {
        if showSpinner && tickets.isEmpty { isLoading = true }
        do {
            let fresh = try await APIService.shared.getTickets(eventId: event.id)
            tickets = fresh
            errorMessage = nil
        } catch is CancellationError {
        } catch {
            if tickets.isEmpty {
                errorMessage = error.localizedDescription
            }
        }
        isLoading = false
    }

    private func loadPushSetting() async {
        pushLoading = true
        pushError = nil
        do {
            pushEnabled = try await APIService.shared.getPushSubscription(eventId: event.id)
        } catch {
            pushError = "Could not load notification setting."
        }
        pushLoading = false
    }

    private func togglePush(_ newValue: Bool) async {
        pushError = nil
        if newValue {
            let granted = await NotificationManager.shared.requestAuthorization()
            if !granted {
                pushEnabled = false
                pushError = "Notifications are disabled in iOS Settings."
                return
            }
            await NotificationManager.shared.syncTokenIfPossible()
        }
        do {
            try await APIService.shared.setPushSubscription(eventId: event.id, enabled: newValue)
            pushEnabled = newValue
        } catch {
            pushError = "Failed to save setting."
            pushEnabled = !newValue
        }
    }

    private func checkInSelected(group: AttendeeGroup, ticketIds: [String]) {
        guard !ticketIds.isEmpty, !checkingIn.contains(group.registrationId) else { return }
        checkingIn.insert(group.registrationId)
        Task {
            var anyFailed = false
            let now = ISO8601DateFormatter().string(from: Date())
            for ticketId in ticketIds {
                do {
                    try await APIService.shared.checkInTicket(ticketId: ticketId)
                    if let idx = tickets.firstIndex(where: { $0.id == ticketId }) {
                        tickets[idx].used_at = now
                    }
                } catch {
                    anyFailed = true
                }
            }
            if anyFailed {
                CheckInFeedback.shared.error()
            } else {
                CheckInFeedback.shared.success()
            }
            checkingIn.remove(group.registrationId)
        }
    }

    private func undoGroup(group: AttendeeGroup) {
        guard !checkingIn.contains(group.registrationId) else { return }
        checkingIn.insert(group.registrationId)
        Task {
            do {
                try await APIService.shared.undoCheckIn(registrationId: group.registrationId)
                for i in tickets.indices where tickets[i].registrationId == group.registrationId {
                    tickets[i].used_at = nil
                }
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

// MARK: - Notification Settings Sheet

private struct NotificationSettingsSheet: View {
    let eventName: String
    let enabled: Bool
    let isLoading: Bool
    let errorMessage: String?
    let onToggle: (Bool) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack { formContent }
                .presentationDetents([.medium])
        } else {
            NavigationView { formContent }
        }
    }

    @ViewBuilder
    private var formContent: some View {
        Form {
            Section {
                Toggle(isOn: Binding(
                    get: { enabled },
                    set: { onToggle($0) }
                )) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("New registrations")
                            .font(.headline)
                        Text("Get a push notification when someone registers for this event.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .disabled(isLoading)
            } header: {
                Text(eventName)
            }

            if isLoading {
                Section {
                    HStack {
                        ProgressView()
                        Text("Loading…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Text(errorMessage)
                        .foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Notifications")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }
}

// MARK: - Ticket Picker Sheet

struct TicketPickerSheet: View {
    let group: AttendeeGroup
    let onConfirm: ([String]) -> Void

    @State private var selected: Set<String> = []

    private var uncheckedTickets: [Ticket] {
        group.tickets.filter { !$0.isCheckedIn }
    }

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack { pickerContent }
                .presentationDetents([.medium, .large])
        } else {
            NavigationView { pickerContent }
        }
    }

    @ViewBuilder
    private var pickerContent: some View {
        List(uncheckedTickets, id: \.id) { ticket in
            Button {
                if selected.contains(ticket.id) {
                    selected.remove(ticket.id)
                } else {
                    selected.insert(ticket.id)
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ticket.name)
                            .font(.body)
                            .foregroundStyle(.primary)
                        Text(ticket.id)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer()
                    if selected.contains(ticket.id) {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(Color.accentColor)
                    } else {
                        Image(systemName: "circle")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
        }
        .navigationTitle("Select Tickets")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { onConfirm([]) }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Check In \(selected.isEmpty ? "" : "(\(selected.count))")") {
                    onConfirm(Array(selected))
                }
                .disabled(selected.isEmpty)
            }
        }
    }
}

// MARK: - Attendee Group Row

struct AttendeeGroupRow: View {
    let group: AttendeeGroup
    let isProcessing: Bool
    var canUndo: Bool = false
    let onCheckInOne: () -> Void
    let onCheckInAll: () -> Void
    var onUndo: () -> Void = {}

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
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(.green)
                    if canUndo {
                        Button(action: onUndo) {
                            Text("Undo")
                                .font(.caption.bold())
                                .padding(.horizontal, 8)
                                .padding(.vertical, 6)
                                .background(Color(.systemGray5))
                                .foregroundStyle(.primary)
                                .clipShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else if isProcessing {
                ProgressView()
                    .scaleEffect(0.8)
            } else {
                let unchecked = group.totalCount - group.checkedInCount
                HStack(spacing: 6) {
                    if unchecked > 1 {
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
                        Text(unchecked > 1 ? "Check In All" : "Check In")
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
