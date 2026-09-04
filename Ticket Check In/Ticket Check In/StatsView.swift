//
//  StatsView.swift
//  Ticket Check In
//
//  Live numbers for the event this device is working — how full the room is,
//  how the door is going, and how many people are still outside it.
//
//  Until now the only place to see any of this was the web dashboard, which on
//  a phone means the "Open Web Dashboard" webview: a full desktop page, pinched
//  and scrolled, while standing at a door. This is the same numbers, read at
//  arm's length.
//
//  It follows the same `lastSelectedEventData` the Scanner and Manual Check-In
//  tabs use, so picking an event once points every tab at it rather than making
//  the operator choose again per tab.
//

import SwiftUI

struct StatsView: View {
    var switchToScanner: () -> Void = {}

    @StateObject private var api = APIService.shared
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()

    @State private var metrics: EventMetrics?
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var lastUpdated: Date?
    @State private var showEventPicker = false
    @State private var refreshTask: Task<Void, Never>?

    /// How often the numbers refresh while the tab is on screen. A door is a
    /// live thing, but nobody needs it to the second — and a phone at a venue
    /// is usually on someone's hotspot, so this stays deliberately gentle.
    private let refreshInterval: TimeInterval = 20

    private var currentEvent: Event? {
        guard !lastSelectedEventData.isEmpty else { return nil }
        return try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
    }

    var body: some View {
        Group {
            if !api.isAuthenticated {
                // The real sign-in screen, not a message about needing one.
                // Stats are the tab someone is most likely to open first on a
                // fresh device — telling them "these belong to an account" and
                // leaving them to find the sign-in form on another tab is a
                // dead end. LoginView brings its own navigation container, its
                // own 2FA step, and the "Skip — Scanner Only" and "Have a scan
                // link?" ways out, so a door volunteer who has no account and
                // never will can still get where they're going from here.
                LoginView(switchToScanner: switchToScanner)
            } else if #available(iOS 16, *) {
                NavigationStack { content }
            } else {
                NavigationView { content }
            }
        }
        // On the outer Group, not on `content`: signed out, `content` isn't in
        // the hierarchy at all, so a task attached to it would never run and
        // the tab could never discover it was in fact signed in.
        .task {
            await api.checkAuth()
            await load()
            startAutoRefresh()
        }
        .onDisappear { refreshTask?.cancel() }
        .onChange(of: api.isAuthenticated) { authenticated in
            // Signing in from this very tab should fill it in, rather than
            // leaving an empty Stats screen until the operator switches tabs
            // and back.
            if authenticated {
                Task { await load() }
                startAutoRefresh()
            } else {
                refreshTask?.cancel()
                metrics = nil
                lastUpdated = nil
            }
        }
        .sheet(isPresented: $showEventPicker) {
            EventPickerSheet(
                onSelectEvent: { event in
                    lastSelectedEventData = (try? JSONEncoder().encode(event)) ?? Data()
                    metrics = nil
                    loadError = nil
                    Task { await load() }
                },
                // A scan link grants check-in on one event and carries no
                // account, so there are no stats to show it — send it where it
                // is actually good for.
                onScanLink: { _ in switchToScanner() }
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        Group {
            if let event = currentEvent {
                loadedState(for: event)
            } else {
                noEventState
            }
        }
        .navigationTitle("Stats")
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                if currentEvent != nil {
                    Button("Switch") { showEventPicker = true }
                }
            }
        }
    }

    // MARK: - Loaded

    @ViewBuilder
    private func loadedState(for event: Event) -> some View {
        List {
            if let error = loadError, metrics == nil {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("Couldn't load stats", systemImage: "exclamationmark.triangle.fill")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.orange)
                        Text(error).font(.footnote).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }

            Section {
                headline(for: metrics)
            } header: {
                Text(metrics?.eventName ?? event.name)
            } footer: {
                // The freshness line matters more than it looks: a number with
                // no timestamp on a flaky connection is a number you can't tell
                // is five seconds or five minutes old.
                if let updated = lastUpdated {
                    Text("Updated \(relativeTime(updated))\(isLoading ? " · refreshing…" : "")")
                } else if isLoading {
                    Text("Loading…")
                }
            }

            if let m = metrics {
                Section("The room") {
                    statRow("Checked in", value: "\(m.scanned)", systemImage: "checkmark.circle.fill", tint: .green)
                    statRow("Not yet in", value: "\(m.notYetIn)", systemImage: "clock.fill", tint: .orange)
                    statRow("Registrations", value: "\(m.uniqueRegistrations)", systemImage: "person.2.fill", tint: .secondary)
                    if let capacity = m.capacity {
                        statRow("Capacity", value: "\(m.total) of \(capacity)", systemImage: "square.grid.2x2.fill", tint: .secondary)
                        if let remaining = m.remaining {
                            statRow(
                                remaining == 0 ? "Sold out" : "Seats left",
                                value: remaining == 0 ? "—" : "\(remaining)",
                                systemImage: remaining == 0 ? "nosign" : "chair.lounge.fill",
                                tint: remaining == 0 ? .red : .secondary
                            )
                        }
                    }
                    if let held = m.held, held > 0 {
                        statRow("Being booked now", value: "\(held)", systemImage: "hourglass", tint: .secondary)
                    }
                }

                if (m.waitlistEnabled ?? false) || (m.waiting ?? 0) > 0 {
                    Section("Waitlist") {
                        statRow("Waiting", value: "\(m.waiting ?? 0)", systemImage: "person.badge.clock.fill", tint: .indigo)
                    }
                }

                if (m.returned ?? 0) > 0 || (m.expired ?? 0) > 0 {
                    Section {
                        if (m.returned ?? 0) > 0 {
                            statRow("Returned by attendees", value: "\(m.returned ?? 0)", systemImage: "arrow.uturn.backward.circle.fill", tint: .secondary)
                        }
                        if (m.expired ?? 0) > 0 {
                            statRow("Expired", value: "\(m.expired ?? 0)", systemImage: "xmark.circle.fill", tint: .secondary)
                        }
                    } header: {
                        Text("Gave up their seat")
                    } footer: {
                        Text("These seats went back into the pool, so they aren't counted in the totals above.")
                    }
                }

                if let timeline = m.checkinTimeline, !timeline.isEmpty {
                    Section("Check-ins by hour") {
                        CheckinTimelineChart(buckets: timeline)
                            .frame(height: 132)
                            .padding(.vertical, 6)
                    }
                }

                Section("Before the door") {
                    statRow("Tickets emailed and opened", value: "\(m.emailOpens)", systemImage: "envelope.open.fill", tint: .secondary)
                    statRow("Added to Apple Wallet", value: "\(m.walletDownloads)", systemImage: "wallet.pass.fill", tint: .secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { await load() }
    }

    /// The one number someone glances at from across a room, and the bar that
    /// makes it readable without doing the division.
    @ViewBuilder
    private func headline(for m: EventMetrics?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(m?.scanned ?? 0)")
                    .font(.system(size: 44, weight: .bold, design: .rounded))
                    .foregroundStyle(.primary)
                Text("of \(m?.total ?? 0) checked in")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                Text("\(m?.pct ?? 0)%")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            ProgressBar(fraction: Double(m?.pct ?? 0) / 100)
                .frame(height: 10)
        }
        .padding(.vertical, 6)
    }

    private func statRow(_ label: String, value: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: systemImage)
                .font(.system(size: 15))
                .foregroundStyle(tint)
                .frame(width: 22)
            Text(label)
            Spacer(minLength: 8)
            Text(value)
                .font(.body.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.primary)
        }
    }

    // MARK: - Empty / signed-out

    @ViewBuilder
    private var noEventState: some View {
        if #available(iOS 17, *) {
            ContentUnavailableView {
                Label("No Event Selected", systemImage: "chart.bar.fill")
            } description: {
                Text("Pick an event to see how its door is going.")
            } actions: {
                Button("Select Event") { showEventPicker = true }
                    .buttonStyle(.borderedProminent)
            }
        } else {
            VStack(spacing: 14) {
                Image(systemName: "chart.bar.fill").font(.largeTitle)
                Text("No Event Selected").font(.headline)
                Text("Pick an event to see how its door is going.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Button("Select Event") { showEventPicker = true }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    // MARK: - Loading

    private func load() async {
        guard api.isAuthenticated, let event = currentEvent else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            metrics = try await api.getMetrics(eventId: event.id)
            lastUpdated = Date()
            loadError = nil
        } catch APIError.unauthorized {
            loadError = "You're not signed in to an account with access to this event."
        } catch {
            // The previously-loaded numbers stay on screen behind this — at a
            // door, slightly stale numbers beat a blank screen.
            loadError = friendlyMetricsError(error)
        }
    }

    private func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(refreshInterval * 1_000_000_000))
                if Task.isCancelled { return }
                await load()
            }
        }
    }

    /// Failures as something the person holding the phone can act on. "HTTP
    /// error 404" in particular is unreadable *and* misleading — it means the
    /// selected event is gone from this account (deleted, or the device is
    /// signed into a different one), which is fixable right here with Switch.
    private func friendlyMetricsError(_ error: Error) -> String {
        if case APIError.httpError(let code) = error {
            switch code {
            case 404: return "That event no longer exists on this account. Tap Switch to pick another."
            case 403: return "This account doesn't have access to that event any more."
            default:  return "The server returned an error (\(code)). Try again in a moment."
            }
        }
        switch (error as? URLError)?.code {
        case .some(.timedOut):
            return "The connection timed out. Check the signal and pull down to retry."
        case .some(.notConnectedToInternet), .some(.networkConnectionLost), .some(.cannotConnectToHost), .some(.cannotFindHost):
            return "No connection to the server. Check the signal and pull down to retry."
        default:
            return error.localizedDescription
        }
    }

    private func relativeTime(_ date: Date) -> String {
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        return "\(seconds / 60)m ago"
    }
}

// MARK: - Small chart pieces
//
// Drawn by hand rather than with Swift Charts: that framework is iOS 16+, and
// this app supports 15.6 (see CLAUDE.md). Two shapes are cheaper than an
// availability-forked chart implemented twice.

private struct ProgressBar: View {
    let fraction: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.18))
                Capsule()
                    .fill(Color.green)
                    .frame(width: max(0, min(1, fraction)) * geo.size.width)
            }
        }
        .animation(.easeOut(duration: 0.3), value: fraction)
    }
}

private struct CheckinTimelineChart: View {
    let buckets: [EventMetrics.CheckinBucket]

    private var peak: Int { max(1, buckets.map(\.count).max() ?? 1) }

    var body: some View {
        // Only every other label when the bars get tight, so the axis stays
        // readable on a phone instead of turning into a grey smear.
        let labelStride = buckets.count > 8 ? 2 : 1
        HStack(alignment: .bottom, spacing: 5) {
            ForEach(Array(buckets.enumerated()), id: \.element.id) { index, bucket in
                VStack(spacing: 4) {
                    Text("\(bucket.count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .opacity(bucket.count == peak ? 1 : 0.65)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.green.opacity(0.85))
                        .frame(height: max(3, CGFloat(bucket.count) / CGFloat(peak) * 78))
                    Text(index % labelStride == 0 ? String(bucket.hour.prefix(2)) : " ")
                        .font(.system(size: 9))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}
