//
//  ContentView.swift
//  Ticket Check In
//

import SwiftUI

struct ContentView: View {
    @State private var selectedTab = 0
    @AppStorage("hasSeenOnboarding") private var hasSeenOnboarding = false

    var body: some View {
        if !hasSeenOnboarding {
            OnboardingView {
                withAnimation { hasSeenOnboarding = true }
            }
        } else {
            TabView(selection: $selectedTab) {
                ScannerView(switchToManual: { selectedTab = 1 })
                    .tabItem { Label("Scanner", systemImage: "qrcode.viewfinder") }
                    .tag(0)
                EventsView()
                    .tabItem { Label("Events", systemImage: "calendar") }
                    .tag(1)
            }
        }
    }
}
