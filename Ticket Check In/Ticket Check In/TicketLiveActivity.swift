//
//  TicketLiveActivity.swift
//  Ticket Check In
//
//  Defines the shared ActivityAttributes used by both the main app and the
//  TicketLiveActivity widget extension, plus the in-app manager that starts
//  and ends activities.
//
//  Xcode setup required:
//  1. File → New → Target → Widget Extension ("TicketLiveActivity")
//     • Uncheck "Include Configuration App Intent"
//     • Deployment target iOS 16.2+
//  2. Add TicketLiveActivityWidget.swift to that new target
//  3. Add THIS file (TicketLiveActivity.swift) to BOTH targets
//     (main app + widget extension) via the File Inspector → Target Membership
//

import ActivityKit
import SwiftUI

// MARK: - Shared Attributes (add to BOTH targets in Xcode)

struct TicketLiveActivityAttributes: ActivityAttributes {
    /// Dynamic state updated during the activity's lifetime
    public struct ContentState: Codable, Hashable {
        var attendeeName: String
        var eventName: String
        var ticketType: String
        var section: String?
        var status: CheckInStatus
        var checkedInAt: Date

        enum CheckInStatus: String, Codable, Hashable {
            case checkedIn, alreadyUsed, reentryEnter, checkingOut, error
        }
    }

    // Static attributes (set once when the activity starts)
    var eventName: String
}

// MARK: - Manager (main app only)

@available(iOS 16.2, *)
final class TicketLiveActivityManager {
    static let shared = TicketLiveActivityManager()
    private init() {}

    private var currentActivity: Activity<TicketLiveActivityAttributes>?
    private var autoEndTask: Task<Void, Never>?

    /// Start (or replace) a Live Activity for the given scan result.
    func start(for result: ScanResult) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // Cancel any pending auto-end
        autoEndTask?.cancel()

        // End previous activity immediately
        if let previous = currentActivity {
            Task { await previous.end(nil, dismissalPolicy: .immediate) }
            currentActivity = nil
        }

        let checkInStatus: TicketLiveActivityAttributes.ContentState.CheckInStatus = {
            switch result.status {
            case .success:             return .checkedIn
            case .reentryEnter:        return .reentryEnter
            case .alreadyUsed:         return .alreadyUsed
            case .reentryExitPrompt:   return .checkingOut
            case .error:               return .error
            }
        }()

        let ticketType = result.customFields?["Ticket Type"]
            ?? result.customFields?["ticket_type"]
            ?? result.customFields?["Type"]
            ?? "General Admission"

        let section = result.customFields?["Section"]
            ?? result.customFields?["section"]
            ?? result.customFields?["Seat"]
            ?? result.customFields?["Row"]

        let state = TicketLiveActivityAttributes.ContentState(
            attendeeName: result.firstName ?? result.name,
            eventName: result.eventName ?? "Event",
            ticketType: ticketType,
            section: section,
            status: checkInStatus,
            checkedInAt: Date()
        )

        let attrs = TicketLiveActivityAttributes(eventName: result.eventName ?? "Event")
        // Stale after 8 s — slightly longer than the overlay dismiss time
        let content = ActivityContent(state: state, staleDate: Date().addingTimeInterval(8))

        Task {
            do {
                currentActivity = try Activity.request(
                    attributes: attrs,
                    content: content,
                    pushType: nil
                )
            } catch {
                print("[LiveActivity] Failed to start: \(error.localizedDescription)")
            }
        }

        // Auto-end after ~5.5 s (matches the overlay dismiss duration)
        autoEndTask = Task {
            try? await Task.sleep(nanoseconds: 5_500_000_000)
            guard !Task.isCancelled else { return }
            await end()
        }
    }

    /// End the current Live Activity immediately.
    func end() async {
        autoEndTask?.cancel()
        guard let activity = currentActivity else { return }
        await activity.end(nil, dismissalPolicy: .immediate)
        currentActivity = nil
    }
}
