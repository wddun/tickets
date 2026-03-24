//
//  ContentView.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import SwiftUI

struct ContentView: View {
    @State private var selectedTab = 0

    var body: some View {
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
