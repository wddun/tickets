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
    @ObservedObject private var api = APIService.shared

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
                ManualCheckInView(switchToScanner: { selectedTab = 0 })
                    .tabItem { Label("Manual Check-In", systemImage: "person.text.rectangle") }
                    .tag(1)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                    .tag(2)
            }
            .onChange(of: api.isAuthenticated) { authenticated in
                if !authenticated { selectedTab = 1 }
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
