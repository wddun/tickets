//
//  SettingsView.swift
//  Ticket Check In
//

import SwiftUI

struct SettingsView: View {
    @ObservedObject private var api = APIService.shared
    @State private var showDisplaySetup = false
    @State private var showDeleteConfirm = false

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    var body: some View {
        NavigationView {
            List {
                // MARK: - Account
                Section("Account") {
                    HStack(spacing: 14) {
                        Image(systemName: "person.circle.fill")
                            .font(.system(size: 38))
                            .foregroundStyle(.blue)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(api.currentUser?.email ?? "—")
                                .font(.system(size: 15, weight: .medium))
                            Text("Signed in")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)

                    Button(role: .destructive) {
                        Task { try? await api.logout() }
                    } label: {
                        Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }

                    Button(role: .destructive) {
                        showDeleteConfirm = true
                    } label: {
                        Label("Delete Account", systemImage: "person.crop.circle.badge.minus")
                    }
                }

                // MARK: - Display & Pairing
                Section("Display & Pairing") {
                    Button {
                        showDisplaySetup = true
                    } label: {
                        HStack {
                            Label("Display Setup", systemImage: "tv")
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                        .foregroundStyle(.primary)
                    }
                }

                // MARK: - About
                Section("About") {
                    HStack {
                        Label("Version", systemImage: "info.circle")
                        Spacer()
                        Text(appVersion)
                            .foregroundStyle(.secondary)
                    }
                    Link(destination: URL(string: "https://tickets.willstechsupport.com/support.html")!) {
                        Label("Support", systemImage: "questionmark.circle")
                    }
                }
            }
            .navigationTitle("Settings")
            .task { await api.checkAuth() }
            .sheet(isPresented: $showDisplaySetup) {
                DisplaySetupView(bluetooth: BluetoothManager.shared)
            }
            .confirmationDialog("Delete Account", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) {
                    Task { try? await api.deleteAccount() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes your account and all data. This cannot be undone.")
            }
        }
    }
}
