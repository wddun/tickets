//
//  ScannerView.swift
//  Ticket Check In
//

import SwiftUI
import AVFoundation
import AudioToolbox

private let adminEmail = "willdunning01@gmail.com"

struct ScannerView: View {
    let switchToManual: () -> Void

    @ObservedObject private var api = APIService.shared
    @ObservedObject private var bluetooth = BluetoothManager.shared
    @AppStorage("scannerPairToken")        private var scannerPairToken: String = ""
    @AppStorage("displayModeActive")       private var displayModeActive   = false
    @AppStorage("displayInitialMode")      private var displayInitialMode  = "bluetooth"
    @AppStorage("displayPreconnectURL")    private var displayPreconnectURL = ""
    @AppStorage("lastSelectedEventData")   private var lastSelectedEventData: Data = Data()
    @AppStorage("scannerMode")             private var scannerMode: String = "none"

    // Full-screen overlay state (reentry exit confirm only)
    @State private var scanResult: ScanResult?
    // History strip at bottom
    @State private var recentScans: [ScanResult] = []
    @State private var isScanning = true
    @State private var lastRegistrationId: String?
    @State private var showingDetail = false
    @State private var showSettings = false
    @State private var lastScannedToken: String?
    @State private var lastScanTime: Date?
    @State private var pendingCheckoutToken: String?
    @State private var flashResult: ScanResult?
    @State private var flashVisible = false
    @State private var flashTask: Task<Void, Never>?
    @State private var heartbeatTask: Task<Void, Never>?
    @State private var notifTask: Task<Void, Never>?
    @State private var adminNotifTitle  = ""
    @State private var adminNotifMsg    = ""
    @State private var showAdminNotif   = false
    private let scanDebounceInterval: TimeInterval = 5.0

    var body: some View {
        ZStack {
            CameraPreviewView(isScanning: $isScanning, onCode: handleCode)
                .ignoresSafeArea()
            viewfinderFrame
            topBar
            statusPills
            bottomBar
            // Full-screen overlay only for reentry exit confirmation
            exitConfirmOverlay
            // 1-second fullscreen scan flash
            if flashVisible, let result = flashResult {
                ScanFlashOverlay(result: result)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .task { await api.checkAuth() }
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            startHeartbeat()
            startNotifListener()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            heartbeatTask?.cancel()
            notifTask?.cancel()
        }
        .alert(adminNotifTitle.isEmpty ? "Admin Message" : adminNotifTitle,
               isPresented: $showAdminNotif) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(adminNotifMsg)
        }
        .onChange(of: bluetooth.receivedResult) { result in
            if let result = result {
                if result.status == "checkout_cmd" {
                    handleConfirmCheckout()
                    bluetooth.receivedResult = nil
                } else if result.status == "checkin_cmd" {
                    handleCheckInCommand()
                    bluetooth.receivedResult = nil
                }
            }
        }
        .sheet(isPresented: $showingDetail) {
            if let result = recentScans.first {
                TicketDetailSheet(result: result)
            }
        }
        .sheet(isPresented: $showSettings) {
            DisplaySetupView(bluetooth: bluetooth)
        }
    }

    @ViewBuilder private var topBar: some View {
        VStack {
            HStack {
                Spacer()
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape.fill")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(.white.opacity(0.85))
                        .padding(10)
                        .background(.black.opacity(0.45), in: Circle())
                }
                .padding(.top, 56)
                .padding(.trailing, 16)
            }
            Spacer()
        }
    }

    // MARK: - Status Pills

    @ViewBuilder private var statusPills: some View {
        VStack {
            // Sits just below the top bar (gear button is ~56pt top + 10pt padding + icon)
            HStack(spacing: 8) {
                blePill
                wifiPill
                modePill
            }
            .padding(.top, 110)   // below the gear button
            Spacer()
        }
    }

    @ViewBuilder private var blePill: some View {
        let dot: Color = {
            switch bluetooth.bleState {
            case .connected:              return .green
            case .scanning:               return .yellow
            case .connecting:             return .yellow
            case .disconnected:           return .orange
            case .unauthorized:           return .red
            default:                      return .gray
            }
        }()
        Label {
            Text("BLE").font(.system(size: 12, weight: .semibold))
        } icon: {
            Circle().fill(dot).frame(width: 7, height: 7)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.black.opacity(0.55), in: Capsule())
    }

    @ViewBuilder private var wifiPill: some View {
        let dot: Color = api.isAuthenticated ? .green : .gray
        Label {
            Text("Server").font(.system(size: 12, weight: .semibold))
        } icon: {
            Circle().fill(dot).frame(width: 7, height: 7)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.black.opacity(0.55), in: Capsule())
    }

    @ViewBuilder private var modePill: some View {
        let text: String? = {
            if scannerMode == "ble" {
                return "Scanner - BLE"
            } else if scannerMode == "internet" {
                return "Scanner - Internet"
            }
            return nil
        }()
        
        if let text = text {
            Label {
                Text(text).font(.system(size: 12, weight: .semibold))
            } icon: {
                Image(systemName: "tv")
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.black.opacity(0.55), in: Capsule())
        }
    }

    @ViewBuilder private var viewfinderFrame: some View {
        VStack {
            Spacer()
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.white.opacity(0.7), lineWidth: 3)
                .frame(width: 260, height: 260)
            Spacer()
            Spacer()
        }
    }

    // Full-screen confirm overlay — reentry exit only
    @ViewBuilder private var exitConfirmOverlay: some View {
        if let result = scanResult, result.status == .reentryExitPrompt {
            ScanResultOverlay(
                result: result,
                onConfirmCheckout: handleConfirmCheckout,
                onCancel: dismissExitOverlay
            )
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: scanResult != nil)
        }
    }

    @ViewBuilder private var bottomBar: some View {
        VStack(spacing: 0) {
            Spacer()
            VStack(spacing: 6) {
                // Last scan — tappable card
                if let last = recentScans.first {
                    Button(action: { showingDetail = true }) {
                        HStack(spacing: 12) {
                            let isGreen = last.status == .success || last.status == .reentryEnter
                            Image(systemName: isGreen ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundStyle(isGreen ? .green : Color(red: 0.9, green: 0.5, blue: 0.1))
                            VStack(alignment: .leading, spacing: 2) {
                                Text(last.firstName ?? last.name)
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundStyle(.white)
                                    .lineLimit(1)
                                Text(last.title)
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.white.opacity(0.6))
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 12, weight: .bold))
                                .foregroundStyle(.white.opacity(0.35))
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                Button(action: switchToManual) {
                    Label("Manual Check-in", systemImage: "person.text.rectangle")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: Capsule())
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 40)
        }
    }

    private func handleCode(_ token: String) {
        // Display QR code — launch display mode directly
        if token.contains("/display.html"), token.contains("token="), URL(string: token) != nil {
            displayPreconnectURL = token
            displayInitialMode   = "wifi"
            displayModeActive    = true
            return
        }

        // 5-second same-token debounce — prevents accidental double-scan
        let now = Date()
        if let lastToken = lastScannedToken, let lastTime = lastScanTime,
           token == lastToken, now.timeIntervalSince(lastTime) < scanDebounceInterval {
            return
        }
        lastScannedToken = token
        lastScanTime = now
        // Camera keeps running — no isScanning = false

        Task {
            do {
                if scannerPairToken.isEmpty { scannerPairToken = UUID().uuidString }
                let response = try await APIService.shared.validateTicket(token: token, pairToken: scannerPairToken)
                await MainActor.run { showResult(for: response, token: token) }
            } catch {
                await MainActor.run {
                    showBanner(ScanResult(status: .error, title: "Error", name: error.localizedDescription))
                    CheckInFeedback.shared.error()
                }
            }
        }
    }

    private func showResult(for response: ValidateResponse, token: String) {
        let result: ScanResult
        switch response.status {
        case "valid":
            lastRegistrationId = response.registrationId ?? response.ticketId
            result = ScanResult(from: response, status: .success, title: "Checked In!")
            CheckInFeedback.shared.success()
            showBanner(result)
            sendToDisplay(response: response, status: "valid")
        case "reentry_enter":
            lastRegistrationId = response.registrationId ?? response.ticketId
            result = ScanResult(from: response, status: .reentryEnter, title: "Checked Back In!")
            CheckInFeedback.shared.success()
            showBanner(result)
            sendToDisplay(response: response, status: "reentry_enter")
        case "reentry_exit":
            pendingCheckoutToken = token
            result = ScanResult(from: response, status: .reentryExitPrompt, title: "Confirm Check-Out")
            CheckInFeedback.shared.alreadyUsed()
            withAnimation { scanResult = result }
            sendToDisplay(response: response, status: "reentry_exit")
        case "used":
            result = ScanResult(from: response, status: .alreadyUsed, title: "Already Checked In")
            CheckInFeedback.shared.alreadyUsed()
            showBanner(result)
            sendToDisplay(response: response, status: "used")
        default:
            result = ScanResult(status: .error, title: "Invalid Ticket", name: response.name ?? "")
            CheckInFeedback.shared.error()
            showBanner(result)
            sendToDisplay(response: response, status: "invalid")
        }
    }

    private func showBanner(_ result: ScanResult) {
        recentScans.insert(result, at: 0)
        if recentScans.count > 1 { recentScans.removeLast() }
        flashTask?.cancel()
        flashResult = result
        withAnimation(.easeInOut(duration: 0.15)) { flashVisible = true }
        flashTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.25)) { flashVisible = false }
        }
    }

    private func handleConfirmCheckout() {
        guard let token = pendingCheckoutToken else { dismissExitOverlay(); return }
        Task {
            try? await APIService.shared.confirmCheckout(token: token)
            await MainActor.run {
                CheckInFeedback.shared.success()
                dismissExitOverlay()
            }
        }
    }

    private func dismissExitOverlay() {
        withAnimation { scanResult = nil }
        pendingCheckoutToken = nil
    }

    private func handleCheckInCommand() {
        // Find the token or registrationId from recentScans or somehow?
        // Wait, on scanner phone, checkin command from display means the last scanned ticket that was used should be checked back in.
        guard let token = lastScannedToken else { return }
        Task {
            if let rid = lastRegistrationId {
                try? await APIService.shared.checkIn(registrationId: rid)
            }
            await MainActor.run {
                CheckInFeedback.shared.success()
            }
        }
    }

    private func sendToDisplay(response: ValidateResponse, status: String) {
        let ble = BLEScanResult(
            status: status,
            name: response.name ?? "Guest",
            firstName: response.firstName,
            eventName: response.eventName,
            registrationId: response.registrationId
        )
        BluetoothManager.shared.sendScanResult(ble)
    }

    private func selectedEventId() -> String? {
        guard !lastSelectedEventData.isEmpty,
              let event = try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
        else { return nil }
        return event.id
    }

    private func startHeartbeat() {
        heartbeatTask?.cancel()
        heartbeatTask = Task { @MainActor in
            while !Task.isCancelled {
                await api.sendHeartbeat(pairToken: scannerPairToken, eventId: selectedEventId())
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30 s
            }
        }
    }

    /// Subscribe to the server SSE scanner stream so admin notifications arrive instantly.
    private func startNotifListener() {
        notifTask?.cancel()
        let eventId = selectedEventId()
        notifTask = Task.detached(priority: .background) { [pairToken = scannerPairToken, baseURL] in
            var urlStr = "\(baseURL)/api/scan/stream/\(pairToken)?platform=ios-app"
            if let eid = eventId { urlStr += "&eventId=\(eid)" }
            guard let url = URL(string: urlStr) else { return }
            let request = URLRequest(url: url, timeoutInterval: .infinity)
            guard let (bytes, _) = try? await URLSession.shared.bytes(for: request) else { return }
            var buffer = ""
            do {
                for try await byte in bytes {
                    if Task.isCancelled { break }
                    buffer += String(bytes: [byte], encoding: .utf8) ?? ""
                    while let range = buffer.range(of: "\n\n") {
                        let chunk = String(buffer[buffer.startIndex..<range.lowerBound])
                        buffer = String(buffer[range.upperBound...])
                        if chunk.hasPrefix("data: "),
                           let data = chunk.dropFirst(6).data(using: .utf8),
                           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                           let type = json["type"] as? String, type == "notification",
                           let message = json["message"] as? String {
                            await MainActor.run {
                                adminNotifTitle = json["title"] as? String ?? "Admin Message"
                                adminNotifMsg   = message
                                showAdminNotif  = true
                            }
                        }
                    }
                }
            } catch { /* stream ended or cancelled — ignore */ }
        }
    }
}

// MARK: - Scan Result Model

struct ScanResult: Equatable {
    enum Status { case success, alreadyUsed, reentryExitPrompt, reentryEnter, error }
    let status: Status
    let title: String
    let name: String
    let firstName: String?
    let email: String?
    let eventName: String?
    let customFields: [String: String]?
    let usedAt: String?

    // Convenience for error case
    init(status: Status, title: String, name: String = "") {
        self.status = status; self.title = title; self.name = name
        self.firstName = nil; self.email = nil; self.eventName = nil
        self.customFields = nil; self.usedAt = nil
    }

    init(from response: ValidateResponse, status: Status, title: String) {
        self.status = status
        self.title = title
        self.name = response.name ?? "Guest"
        self.firstName = response.firstName
        self.email = response.email
        self.eventName = response.eventName
        self.customFields = response.customFields
        self.usedAt = response.used_at
    }
}

struct ScanFlashOverlay: View {
    let result: ScanResult

    private var color: Color {
        switch result.status {
        case .success, .reentryEnter: return Color(red: 0.07, green: 0.53, blue: 0.25)
        case .alreadyUsed, .reentryExitPrompt: return Color(red: 0.75, green: 0.37, blue: 0.06)
        case .error: return Color(red: 0.72, green: 0.12, blue: 0.12)
        }
    }

    private var icon: String {
        switch result.status {
        case .success, .reentryEnter: return "checkmark.circle.fill"
        case .alreadyUsed:            return "exclamationmark.circle.fill"
        default:                      return "xmark.circle.fill"
        }
    }

    var body: some View {
        ZStack {
            color.ignoresSafeArea()
            VStack(spacing: 20) {
                Image(systemName: icon)
                    .font(.system(size: 80, weight: .bold))
                    .foregroundStyle(.white)
                Text(result.firstName ?? result.name)
                    .font(.system(size: 42, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Text(result.title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
            }
        }
    }
}

// MARK: - Full-Screen Result Overlay (exit confirm only)

struct ScanResultOverlay: View {
    let result: ScanResult
    var onConfirmCheckout: (() -> Void)? = nil
    var onCancel: (() -> Void)? = nil

    var overlayColor: Color {
        switch result.status {
        case .success, .reentryEnter: return .green
        case .alreadyUsed, .reentryExitPrompt: return Color(red: 0.9, green: 0.5, blue: 0.1)
        case .error: return .red
        }
    }

    var icon: String {
        switch result.status {
        case .success: return "checkmark.circle.fill"
        case .reentryEnter: return "arrow.right.circle.fill"
        case .alreadyUsed: return "exclamationmark.circle.fill"
        case .reentryExitPrompt: return "door.left.hand.open"
        case .error: return "xmark.circle.fill"
        }
    }

    var body: some View {
        ZStack {
            overlayColor.opacity(0.92).ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Icon + name
                VStack(spacing: 12) {
                    Image(systemName: icon)
                        .font(.system(size: 64))
                        .foregroundStyle(.white)

                    Text(result.title)
                        .font(.system(size: 22, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))

                    Text(result.firstName ?? result.name)
                        .font(.system(size: 38, weight: .bold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)

                    if let email = result.email {
                        Text(email)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.white.opacity(0.75))
                    }

                    if let eventName = result.eventName {
                        Text(eventName)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.white.opacity(0.7))
                            .padding(.top, 2)
                    }
                }

                // Custom fields
                if let fields = result.customFields, !fields.isEmpty {
                    VStack(spacing: 8) {
                        ForEach(fields.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                            HStack {
                                Text(key)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(.white.opacity(0.7))
                                Spacer()
                                Text(value)
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(.white)
                            }
                            .padding(.horizontal, 20)
                            .padding(.vertical, 6)
                            .background(.white.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    .padding(.horizontal, 32)
                    .padding(.top, 20)
                }

                if let usedAt = result.usedAt, result.status == .alreadyUsed {
                    Text("Scanned \(formattedDate(usedAt))")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.65))
                        .padding(.top, 12)
                }

                Spacer()

                // Action buttons — exit confirm only
                VStack(spacing: 12) {
                    if let onConfirmCheckout {
                        Button(action: onConfirmCheckout) {
                            Text("Confirm Check-Out")
                                .font(.system(size: 17, weight: .bold))
                                .foregroundStyle(overlayColor)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 14))
                        }
                    }
                    if let onCancel {
                        Button(action: onCancel) {
                            Text("Cancel")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(.white.opacity(0.75))
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.bottom, 56)
            }
        }
    }

    private func formattedDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let fmt = DateFormatter()
        fmt.dateStyle = .short
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }
}

// MARK: - Ticket Detail Sheet

struct TicketDetailSheet: View {
    let result: ScanResult
    @Environment(\.dismiss) private var dismiss

    var statusColor: Color {
        result.status == .success ? .green : Color(red: 0.9, green: 0.5, blue: 0.1)
    }

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {

                // Status badge + name
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 8) {
                        Image(systemName: result.status == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                            .foregroundStyle(statusColor)
                        Text(result.title)
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(statusColor)
                    }

                    Text(result.name)
                        .font(.system(size: 28, weight: .bold))

                    if let email = result.email {
                        Text(email)
                            .font(.system(size: 15))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 4)

                Divider()

                if let eventName = result.eventName {
                    DetailRow(label: "Event", value: eventName)
                }

                if let usedAt = result.usedAt {
                    DetailRow(label: "Checked In", value: formattedDate(usedAt))
                }

                if let fields = result.customFields, !fields.isEmpty {
                    Divider()
                    Text("Additional Info")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .textCase(.uppercase)

                    ForEach(fields.sorted(by: { $0.key < $1.key }), id: \.key) { key, value in
                        DetailRow(label: key, value: value)
                    }
                }
            }
            .padding(24)
        }
        .navigationTitle("Ticket Details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    var body: some View {
        if #available(iOS 16.0, *) {
            NavigationStack { content }
        } else {
            NavigationView { content }
        }
    }

    private func formattedDate(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        guard let date = parser.date(from: iso) else { return iso }
        let fmt = DateFormatter()
        fmt.dateStyle = .medium
        fmt.timeStyle = .short
        return fmt.string(from: date)
    }
}

private struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Text(value)
                .font(.system(size: 16))
        }
    }
}

// MARK: - Sound & Haptic Feedback

class CheckInFeedback {
    static let shared = CheckInFeedback()
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat

    private init() {
        engine.attach(player)
        format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
        engine.connect(player, to: engine.mainMixerNode, format: format)
        try? engine.start()
    }

    /// 2 quick impact taps + ascending C5→A5 sine tones (matches website success)
    func success() {
        let gen = UIImpactFeedbackGenerator(style: .rigid)
        gen.impactOccurred()
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 100_000_000)
            gen.impactOccurred()
        }
        scheduleNote(frequency: 523.25, duration: 0.18, volume: 0.45)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            self.scheduleNote(frequency: 880, duration: 0.28, volume: 0.45)
        }
    }

    /// Long vibration + descending A3→A#2 square tones (matches website error)
    func alreadyUsed() {
        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        scheduleNote(frequency: 220, duration: 0.15, volume: 0.5, square: true)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            self.scheduleNote(frequency: 180, duration: 0.28, volume: 0.5, square: true)
        }
    }

    /// Error haptic + descending square tones
    func error() {
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        scheduleNote(frequency: 220, duration: 0.15, volume: 0.5, square: true)
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 180_000_000)
            self.scheduleNote(frequency: 180, duration: 0.28, volume: 0.5, square: true)
        }
    }

    private func scheduleNote(frequency: Float, duration: Double, volume: Float, square: Bool = false) {
        let sampleRate = 44100.0
        let totalFrames = Int(sampleRate * duration)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(totalFrames)) else { return }
        buffer.frameLength = AVAudioFrameCount(totalFrames)
        let data = buffer.floatChannelData![0]
        let fadeStart = Int(Double(totalFrames) * 0.65)
        for i in 0..<totalFrames {
            let t = Float(i) / Float(sampleRate)
            let raw: Float = square
                ? (sinf(2.0 * .pi * frequency * t) >= 0 ? 1.0 : -1.0)
                : sinf(2.0 * .pi * frequency * t)
            let fade: Float = i < fadeStart ? 1.0 : Float(totalFrames - i) / Float(totalFrames - fadeStart)
            data[i] = raw * volume * fade
        }
        player.scheduleBuffer(buffer)
        if !player.isPlaying { player.play() }
    }
}

// MARK: - Camera Preview

struct CameraPreviewView: UIViewRepresentable {
    @Binding var isScanning: Bool
    let onCode: (String) -> Void

    func makeUIView(context: Context) -> CameraView {
        let view = CameraView()
        view.backgroundColor = .black
        view.setup(coordinator: context.coordinator)
        return view
    }

    func updateUIView(_ uiView: CameraView, context: Context) {
        let session = context.coordinator.session
        if isScanning && !(session?.isRunning ?? false) {
            DispatchQueue.global(qos: .userInitiated).async { session?.startRunning() }
        } else if !isScanning && (session?.isRunning ?? false) {
            DispatchQueue.global(qos: .userInitiated).async { session?.stopRunning() }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode)
    }

    // UIView subclass so layoutSubviews keeps preview layer sized and oriented correctly
    class CameraView: UIView {
        var previewLayer: AVCaptureVideoPreviewLayer?

        func setup(coordinator: Coordinator) {
            let session = AVCaptureSession()
            coordinator.session = session

            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input) else { return }
            session.addInput(input)

            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(coordinator, queue: .main)
                output.metadataObjectTypes = [.qr]
            }

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.videoGravity = .resizeAspectFill
            layer.addSublayer(preview)
            previewLayer = preview
            coordinator.previewLayer = preview

            DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            previewLayer?.frame = bounds
            updateVideoOrientation()
        }

        private func updateVideoOrientation() {
            guard let connection = previewLayer?.connection else { return }
            if #available(iOS 17.0, *) {
                guard connection.isVideoRotationAngleSupported(90) else { return }
                let angle: CGFloat
                switch window?.windowScene?.interfaceOrientation {
                case .landscapeLeft:           angle = 180
                case .landscapeRight:          angle = 0
                case .portraitUpsideDown:      angle = 270
                default:                       angle = 90   // portrait (default)
                }
                connection.videoRotationAngle = angle
            } else {
                guard connection.isVideoOrientationSupported else { return }
                switch window?.windowScene?.interfaceOrientation {
                case .landscapeLeft:           connection.videoOrientation = .landscapeLeft
                case .landscapeRight:          connection.videoOrientation = .landscapeRight
                case .portraitUpsideDown:      connection.videoOrientation = .portraitUpsideDown
                default:                       connection.videoOrientation = .portrait
                }
            }
        }
    }

    class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var session: AVCaptureSession?
        var previewLayer: AVCaptureVideoPreviewLayer?
        let onCode: (String) -> Void

        init(onCode: @escaping (String) -> Void) {
            self.onCode = onCode
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let code = object.stringValue, !code.isEmpty else { return }
            onCode(code)
        }
    }
}
