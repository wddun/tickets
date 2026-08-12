//
//  OnboardingView.swift
//  Ticket Check In
//

import SwiftUI

struct OnboardingView: View {
    var onFinish: () -> Void

    @State private var page = 0

    private let pages: [OnboardingPage] = [
        OnboardingPage(
            icon: nil,
            useLogo: true,
            title: "WTS Tickets",
            body: "Scan QR codes or manually check in attendees to your events — fast and simple.",
            buttonLabel: "Get Started"
        ),
        OnboardingPage(
            icon: "qrcode.viewfinder",
            useLogo: false,
            title: "Scan Tickets",
            body: "Point the camera at any ticket QR code for instant audio and haptic feedback. Tap any recent scan at the bottom to see full details, including custom fields.",
            buttonLabel: "Next"
        ),
        OnboardingPage(
            icon: "calendar",
            useLogo: false,
            title: "Pick Your Event",
            body: "Tap Events to choose which one you're scanning for — tap anywhere on a row to switch. Or share a scan link from the dashboard so others can scan without needing an account.",
            buttonLabel: "Next"
        ),
        OnboardingPage(
            icon: "tv",
            useLogo: false,
            title: "Pair a Door Display",
            body: "Turn any nearby phone or tablet into a live door display. Find it under Settings → Display Setup — pair over Bluetooth or by scanning a QR code, no extra app needed.",
            buttonLabel: "Next"
        ),
        OnboardingPage(
            icon: "person.badge.plus",
            useLogo: false,
            title: "Manual Check-In",
            body: "Browse attendees, search by name or email, and tap to check in one ticket at a time or all at once. The list auto-refreshes every 30 seconds.",
            buttonLabel: "Let's Go"
        )
    ]

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [Color(hex: "0e1234"), Color(hex: "1a2060")],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()

            VStack(spacing: 0) {
                // Page indicators
                HStack(spacing: 8) {
                    ForEach(0..<pages.count, id: \.self) { i in
                        Capsule()
                            .fill(i == page ? Color.white : Color.white.opacity(0.3))
                            .frame(width: i == page ? 24 : 8, height: 8)
                            .animation(.spring(response: 0.3), value: page)
                    }
                }
                .padding(.top, 60)

                Spacer()

                let p = pages[page]

                // Icon / logo
                Group {
                    if p.useLogo {
                        LogoView(size: 110)
                    } else {
                        LogoView(size: 110, systemImage: p.icon!)
                    }
                }
                .padding(.bottom, 40)

                Text(p.title)
                    .font(.system(size: 34, weight: .bold))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.bottom, 16)

                Text(p.body)
                    .font(.body)
                    .foregroundStyle(.white.opacity(0.75))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 36)

                Spacer()

                Button(action: advance) {
                    Text(p.buttonLabel)
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color(hex: "34c759"))
                        .foregroundStyle(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .padding(.horizontal, 28)
                .padding(.bottom, 8)

                Text("© Will's Tech Support · support@willstechsupport.com")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.4))
                    .padding(.bottom, 40)
            }
        }
        .transition(.opacity)
    }

    private func advance() {
        if page < pages.count - 1 {
            withAnimation { page += 1 }
        } else {
            onFinish()
        }
    }
}

private struct OnboardingPage {
    let icon: String?
    let useLogo: Bool
    let title: String
    let body: String
    let buttonLabel: String
}
