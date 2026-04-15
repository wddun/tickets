//
//  TicketLiveActivityWidget.swift
//  TicketLiveActivity  ← Widget Extension target
//
//  Shows a Ticketmaster-style verified-ticket card on the lock screen and
//  a compact status indicator in the Dynamic Island.
//
//  Xcode setup:
//  • This file belongs to the TicketLiveActivity widget extension target ONLY
//  • TicketLiveActivity.swift (the shared attributes) must also be added to
//    this target via File Inspector → Target Membership
//

import ActivityKit
import WidgetKit
import SwiftUI

// MARK: - Bundle entry point

@main
struct TicketLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        TicketLiveActivityWidget()
    }
}

// MARK: - Widget

struct TicketLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TicketLiveActivityAttributes.self) { context in
            LockScreenTicketView(context: context)
                .activityBackgroundTint(Color.black)
        } dynamicIsland: { context in
            DynamicIsland {
                // ── Expanded ──────────────────────────────────────────────
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        Image(systemName: context.state.status.icon)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(context.state.status.color)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(context.state.attendeeName)
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text(context.state.ticketType)
                                .font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.6))
                                .lineLimit(1)
                        }
                    }
                    .padding(.leading, 4)
                }

                DynamicIslandExpandedRegion(.trailing) {
                    if let section = context.state.section {
                        VStack(alignment: .trailing, spacing: 0) {
                            Text("Sec")
                                .font(.system(size: 10))
                                .foregroundStyle(.white.opacity(0.55))
                            Text(section)
                                .font(.system(size: 20, weight: .bold))
                                .foregroundStyle(.white)
                        }
                        .padding(.trailing, 4)
                    } else {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(context.state.status.color)
                            .padding(.trailing, 4)
                    }
                }

                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Image(systemName: context.state.status.icon)
                            .font(.system(size: 11))
                            .foregroundStyle(context.state.status.color)
                        Text(context.state.status.label)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(context.state.status.color)
                        Spacer()
                        Text(context.attributes.eventName)
                            .font(.system(size: 11))
                            .foregroundStyle(.white.opacity(0.5))
                            .lineLimit(1)
                        Text("ticket check in")
                            .font(.system(size: 11))
                            .italic()
                            .foregroundStyle(.white.opacity(0.35))
                    }
                    .padding(.horizontal, 4)
                    .padding(.bottom, 2)
                }

            } compactLeading: {
                Image(systemName: context.state.status.icon)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(context.state.status.color)

            } compactTrailing: {
                Text(context.state.attendeeName)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .frame(maxWidth: 80)

            } minimal: {
                Image(systemName: context.state.status.icon)
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(context.state.status.color)
            }
            .keylineTint(context.state.status.color)
        }
    }
}

// MARK: - Lock Screen Card

private struct LockScreenTicketView: View {
    let context: ActivityViewContext<TicketLiveActivityAttributes>

    var body: some View {
        VStack(spacing: 0) {
            // ── Header ───────────────────────────────────────────────────
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.14, green: 0.13, blue: 0.17),
                        Color(red: 0.08, green: 0.08, blue: 0.10)
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )

                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(context.state.attendeeName)
                            .font(.system(size: 16, weight: .bold))
                            .foregroundStyle(.white)
                        Text(context.attributes.eventName)
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.6))
                            .lineLimit(1)
                    }
                    Spacer()
                    // Status badge
                    HStack(spacing: 5) {
                        Image(systemName: context.state.status.icon)
                            .font(.system(size: 13, weight: .bold))
                        Text(context.state.status.label)
                            .font(.system(size: 13, weight: .bold))
                    }
                    .foregroundStyle(context.state.status.color)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(context.state.status.color.opacity(0.15), in: Capsule())
                }
                .padding(.horizontal, 14)
            }
            .frame(height: 60)

            // ── Perforation ───────────────────────────────────────────────
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.14, green: 0.13, blue: 0.17),
                        Color(red: 0.18, green: 0.18, blue: 0.20)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                HStack(spacing: 4) {
                    ForEach(0..<24, id: \.self) { _ in
                        Capsule()
                            .fill(Color(white: 0.32))
                            .frame(width: 5, height: 1.5)
                    }
                }
            }
            .frame(height: 18)

            // ── Footer ────────────────────────────────────────────────────
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.state.ticketType.uppercased())
                        .font(.system(size: 18, weight: .heavy))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(context.state.status.color)
                        Text("Verified Ticket")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                }
                Spacer()
                if let section = context.state.section {
                    VStack(alignment: .trailing, spacing: -2) {
                        Text("Sec")
                            .font(.system(size: 10))
                            .foregroundStyle(.white.opacity(0.55))
                        Text(section)
                            .font(.system(size: 26, weight: .bold))
                            .foregroundStyle(.white)
                    }
                } else {
                    Text("ticket check in")
                        .font(.system(size: 11))
                        .italic()
                        .foregroundStyle(.white.opacity(0.35))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(red: 0.18, green: 0.18, blue: 0.20))
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .padding(12)
    }
}

// MARK: - Status helpers

private extension TicketLiveActivityAttributes.ContentState.CheckInStatus {
    var icon: String {
        switch self {
        case .checkedIn, .reentryEnter: return "checkmark.seal.fill"
        case .alreadyUsed:              return "exclamationmark.circle.fill"
        case .checkingOut:              return "door.left.hand.open"
        case .error:                    return "xmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .checkedIn, .reentryEnter: return .green
        case .alreadyUsed:              return Color(red: 1, green: 0.62, blue: 0.1)
        case .checkingOut:              return Color(red: 1, green: 0.62, blue: 0.1)
        case .error:                    return .red
        }
    }

    var label: String {
        switch self {
        case .checkedIn:    return "Checked In"
        case .reentryEnter: return "Checked Back In"
        case .alreadyUsed:  return "Already Used"
        case .checkingOut:  return "Checking Out"
        case .error:        return "Invalid"
        }
    }
}
