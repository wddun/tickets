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
