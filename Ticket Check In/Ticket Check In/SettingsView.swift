//
//  SettingsView.swift
//  Ticket Check In
//

import SwiftUI
import UserNotifications

struct SettingsView: View {
    @ObservedObject private var api = APIService.shared
    @State private var showDisplaySetup = false
    @State private var showDeleteConfirm = false
    @State private var isSigningOut = false
    @State private var isDeleting = false
    @State private var actionError: String?
    @State private var notifStatus: UNAuthorizationStatus = .notDetermined

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—"
    }

    var body: some View {
        NavigationView {
            List {
                // MARK: - Account
                Section("Account") {
                    if api.isAuthenticated, let user = api.currentUser {
                        HStack(spacing: 14) {
                            Image(systemName: "person.circle.fill")
                                .font(.system(size: 38))
                                .foregroundStyle(.blue)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(user.email)
                                    .font(.system(size: 15, weight: .medium))
                                Text(user.isAdmin == true ? "Admin" : "Signed in")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)

                        if let error = actionError {
                            Text(error)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }

                        Button(role: .destructive) {
                            signOut()
                        } label: {
                            HStack {
                                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                                if isSigningOut {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isSigningOut || isDeleting)

                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            HStack {
                                Label("Delete Account", systemImage: "person.crop.circle.badge.minus")
                                if isDeleting {
                                    Spacer()
                                    ProgressView()
                                }
                            }
                        }
                        .disabled(isSigningOut || isDeleting)
                    } else {
                        HStack(spacing: 14) {
                            Image(systemName: "person.crop.circle.badge.questionmark")
                                .font(.system(size: 38))
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Not signed in")
                                    .font(.system(size: 15, weight: .medium))
                                Text("Sign in on the Events tab")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }

                // MARK: - Notifications
                Section("Notifications") {
                    HStack {
                        Label("Status", systemImage: notifStatusIcon)
                        Spacer()
                        Text(notifStatusLabel)
                            .foregroundStyle(.secondary)
                            .font(.subheadline)
                    }

                    if notifStatus != .authorized && notifStatus != .provisional {
                        Button {
                            if let url = URL(string: UIApplication.openSettingsURLString) {
                                UIApplication.shared.open(url)
                            }
                        } label: {
                            Label("Open iOS Settings", systemImage: "gear")
                        }
                    }

                    Text("Per-event notification preferences are managed from the bell icon inside each event's attendee list.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
            .task { await refreshNotifStatus() }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                Task { await refreshNotifStatus() }
            }
            .sheet(isPresented: $showDisplaySetup) {
                DisplaySetupView(bluetooth: BluetoothManager.shared)
            }
            .confirmationDialog("Delete Account", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) {
                    deleteAccount()
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This permanently removes your account and all data. This cannot be undone.")
            }
        }
    }

    private var notifStatusIcon: String {
        switch notifStatus {
        case .authorized, .provisional, .ephemeral: return "bell.fill"
        case .denied: return "bell.slash.fill"
        default: return "bell"
        }
    }

    private var notifStatusLabel: String {
        switch notifStatus {
        case .authorized, .provisional, .ephemeral: return "Enabled"
        case .denied: return "Disabled"
        default: return "Not set"
        }
    }

    private func refreshNotifStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        notifStatus = settings.authorizationStatus
    }

    private func signOut() {
        isSigningOut = true
        actionError = nil
        Task {
            do {
                try await api.logout()
            } catch {
                actionError = "Sign out failed. Try again."
            }
            isSigningOut = false
        }
    }

    private func deleteAccount() {
        isDeleting = true
        actionError = nil
        Task {
            do {
                try await api.deleteAccount()
            } catch {
                actionError = "Failed to delete account. Try again."
            }
            isDeleting = false
        }
    }
}
