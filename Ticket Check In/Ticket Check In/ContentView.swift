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
    @AppStorage("scanLinkEventData")    private var scanLinkEventData    = Data()
    @AppStorage("scanLinkJustEntered")  private var scanLinkJustEntered  = false
    @StateObject private var bluetooth = BluetoothManager.shared
    @ObservedObject private var api = APIService.shared
    @State private var deepLinkError: String?

    var body: some View {
        // Attached outside the onboarding branch so a link tapped on a fresh
        // install still lands — it skips onboarding and goes straight to the
        // scanner, which is all door staff opening a scan link want.
        mainContent
            .onOpenURL { url in openScanLink(url) }
            .alert("Couldn't open scan link", isPresented: Binding(
                get: { deepLinkError != nil },
                set: { if !$0 { deepLinkError = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(deepLinkError ?? "")
            }
    }

    /// A scan link opened from outside the app — a Universal Link
    /// (https://tickets.willstechsupport.com/scan/<token>, which iOS routes
    /// here when the app is installed) or wtstickets://scan/<token>. Resolves
    /// it the same way pasting it into the Scan Link sheet does, then locks
    /// the scanner to that event.
    private func openScanLink(_ url: URL) {
        let token = ScanLinkEntrySheet.extractToken(from: url.absoluteString)
        guard ScanLinkEntrySheet.isPlausibleToken(token) else { return }
        Task {
            do {
                let link = try await APIService.shared.resolveScannerLink(token: token)
                scanLinkEventData = (try? JSONEncoder().encode(link)) ?? Data()
                scanLinkJustEntered = true
                hasSeenOnboarding = true
                displayModeActive = false
                selectedTab = 0
            } catch {
                deepLinkError = error.localizedDescription
            }
        }
    }

    @ViewBuilder
    private var mainContent: some View {
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
                StatsView(switchToScanner: { selectedTab = 0 })
                    .tabItem { Label("Stats", systemImage: "chart.bar.fill") }
                    .tag(2)
                SettingsView()
                    .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                    .tag(3)
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
