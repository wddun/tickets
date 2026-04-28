//
//  ContentView.swift
//  Ticket Check In
//

import SwiftUI

struct ContentView: View {
    @State private var selectedTab = 0
    @AppStorage("hasSeenOnboarding")    private var hasSeenOnboarding    = false
    @AppStorage("displayModeActive")    private var displayModeActive    = false
    @AppStorage("displayInitialMode")   private var displayInitialMode   = "bluetooth"
    @AppStorage("displayPreconnectURL") private var displayPreconnectURL = ""
    @StateObject private var bluetooth = BluetoothManager.shared

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
                EventsView(switchToScanner: { selectedTab = 0 })
                    .tabItem { Label("Events", systemImage: "calendar") }
                    .tag(1)
            }
            // Fullscreen display mode — covers entire app when active
            .fullScreenCover(isPresented: $displayModeActive) {
                DisplayView(
                    bluetooth: bluetooth,
                    initialMode: displayInitialMode,
                    preconnectURL: displayPreconnectURL
                ) {
                    displayModeActive    = false
                    displayPreconnectURL = ""
                }
            }
        }
    }
}
