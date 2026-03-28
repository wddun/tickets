//
//  Ticket_Check_InApp.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import SwiftUI
import UIKit

@main
struct Ticket_Check_InApp: App {
    init() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor.systemBackground

        let normalColor = UIColor.secondaryLabel
        let selectedColor = UIColor(named: "AccentColor") ?? UIColor.systemBlue
        appearance.stackedLayoutAppearance.normal.iconColor = normalColor
        appearance.stackedLayoutAppearance.normal.titleTextAttributes = [
            .foregroundColor: normalColor
        ]
        appearance.stackedLayoutAppearance.selected.iconColor = selectedColor
        appearance.stackedLayoutAppearance.selected.titleTextAttributes = [
            .foregroundColor: selectedColor
        ]

        UITabBar.appearance().standardAppearance = appearance
        if #available(iOS 15.0, *) {
            UITabBar.appearance().scrollEdgeAppearance = appearance
        }
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
