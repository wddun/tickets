//
//  NotificationManager.swift
//  Ticket Check In
//

import Foundation
import UserNotifications
import UIKit

final class NotificationManager: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationManager()

    private let tokenKey = "apnsDeviceToken"

    private override init() {
        super.init()
    }

    /// This device's raw APNs token, if registration has completed. Reported
    /// in scanner heartbeats so the server can push directly to this device
    /// even when it isn't tied to a logged-in user account (e.g. a PIN-only
    /// scanner session).
    var deviceToken: String? {
        UserDefaults.standard.string(forKey: tokenKey)
    }

    /// Read-only check — unlike requestAuthorization(), never prompts.
    /// Used to report this device's push status in scanner heartbeats so
    /// admin can see (in the Monitor tab) which devices don't have
    /// notifications enabled and nudge them in person.
    func isAuthorized() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    func requestAuthorization() async -> Bool {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            await MainActor.run { UIApplication.shared.registerForRemoteNotifications() }
            return true
        case .denied:
            return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
                    if granted {
                        DispatchQueue.main.async {
                            UIApplication.shared.registerForRemoteNotifications()
                        }
                    }
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }

    func handleDeviceToken(_ tokenData: Data) {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: tokenKey)
        Task { await syncTokenIfPossible() }
    }

    @MainActor
    func syncTokenIfPossible() async {
        guard let token = UserDefaults.standard.string(forKey: tokenKey) else { return }
        guard APIService.shared.isAuthenticated else { return }
        try? await APIService.shared.registerPushToken(token)
    }

    // Show notifications while app is in foreground
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }
}
