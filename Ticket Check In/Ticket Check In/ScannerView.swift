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

    @State private var scanResult: ScanResult?
    @State private var lastResult: ScanResult?       // persists after overlay dismisses
    @State private var isScanning = true
    @State private var isProcessing = false
    @State private var lastRegistrationId: String?
    @State private var dismissTask: Task<Void, Never>?
    @State private var showingDetail = false
    @State private var lastScannedToken: String?
    @State private var lastScanTime: Date?
    @State private var pendingCheckoutToken: String?
    private let scanDebounceInterval: TimeInterval = 5.0

    private var canUndo: Bool {
        api.currentUser?.email == adminEmail
    }

    var body: some View {
        ZStack {
            CameraPreviewView(isScanning: $isScanning, onCode: handleCode)
                .ignoresSafeArea()
            viewfinderFrame
            bottomBar
            resultOverlay
        }
        .task { await api.checkAuth() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sheet(isPresented: $showingDetail) {
            if let result = lastResult {
                TicketDetailSheet(result: result)
            }
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

    private var undoAction: (() -> Void)? {
        guard let result = scanResult, canUndo, result.status == .success else { return nil }
        return handleUndo
    }

    private var detailAction: (() -> Void)? {
        guard let result = scanResult, result.status != .error, result.status != .reentryExitPrompt else { return nil }
        return { showingDetail = true }
    }

    private var confirmCheckoutAction: (() -> Void)? {
        guard let result = scanResult, result.status == .reentryExitPrompt else { return nil }
        return handleConfirmCheckout
    }

    private var cancelAction: (() -> Void)? {
        guard let result = scanResult, result.status == .reentryExitPrompt else { return nil }
        return dismiss
    }

    @ViewBuilder private var resultOverlay: some View {
        if let result = scanResult {
            ScanResultOverlay(
                result: result,
                onUndo: undoAction,
                onViewDetails: detailAction,
                onConfirmCheckout: confirmCheckoutAction,
                onCancel: cancelAction
            )
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: scanResult != nil)
        }
    }

    @ViewBuilder private var bottomBar: some View {
        VStack {
            Spacer()
            HStack(spacing: 12) {
                Button(action: switchToManual) {
                    Label("Manual Check-in", systemImage: "person.text.rectangle")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                lastScanChip
            }
            .padding(.bottom, 40)
        }
    }

    @ViewBuilder private var lastScanChip: some View {
        if let last = lastResult {
            Button(action: { showingDetail = true }) {
                HStack(spacing: 6) {
                    let isGreen = last.status == .success || last.status == .reentryEnter
                    Image(systemName: isGreen ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .foregroundStyle(isGreen ? .green : .orange)
                    Text(last.firstName ?? last.name)
                        .lineLimit(1)
                }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial, in: Capsule())
            }
            .opacity(scanResult == nil ? 1 : 0)
        }
    }

    private func handleCode(_ token: String) {
        // 5-second same-token debounce
        let now = Date()
        if let lastToken = lastScannedToken, let lastTime = lastScanTime,
           token == lastToken, now.timeIntervalSince(lastTime) < scanDebounceInterval {
            return
        }

        guard !isProcessing else { return }
        isProcessing = true
        isScanning = false
        lastScannedToken = token
        lastScanTime = now

        Task {
            do {
                let response = try await APIService.shared.validateTicket(token: token)
                await MainActor.run { showResult(for: response, token: token) }
            } catch {
                await MainActor.run {
                    scanResult = ScanResult(status: .error, title: "Error", name: error.localizedDescription)
                    CheckInFeedback.shared.error()
                    scheduleDismiss()
                }
            }
        }
    }

    private func showResult(for response: ValidateResponse, token: String) {
        let name = response.name ?? "Guest"
        let result: ScanResult
        switch response.status {
        case "valid":
            lastRegistrationId = response.registrationId ?? response.ticketId
            result = ScanResult(from: response, status: .success, title: "Checked In!")
            CheckInFeedback.shared.success()
        case "reentry_enter":
            lastRegistrationId = response.registrationId ?? response.ticketId
            result = ScanResult(from: response, status: .reentryEnter, title: "Checked Back In!")
            CheckInFeedback.shared.success()
        case "reentry_exit":
            pendingCheckoutToken = token
            result = ScanResult(from: response, status: .reentryExitPrompt, title: "Confirm Check-Out")
            CheckInFeedback.shared.alreadyUsed()
            scanResult = result
            lastResult = result
            if #available(iOS 16.2, *) { TicketLiveActivityManager.shared.start(for: result) }
            // No auto-dismiss for exit confirmation — requires manual action
            return
        case "used":
            result = ScanResult(from: response, status: .alreadyUsed, title: "Already Checked In")
            CheckInFeedback.shared.alreadyUsed()
        default:
            result = ScanResult(status: .error, title: "Invalid Ticket", name: name)
            CheckInFeedback.shared.error()
        }
        scanResult = result
        lastResult = result
        if #available(iOS 16.2, *) { TicketLiveActivityManager.shared.start(for: result) }
        scheduleDismiss()
    }

    private func scheduleDismiss() {
        dismissTask?.cancel()
        dismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            guard !Task.isCancelled else { return }
            withAnimation { scanResult = nil }
            isProcessing = false
            isScanning = true
        }
    }

    private func handleUndo() {
        dismissTask?.cancel()
        guard let registrationId = lastRegistrationId else {
            dismiss()
            return
        }
        Task {
            try? await APIService.shared.undoCheckIn(registrationId: registrationId)
            await MainActor.run { dismiss() }
        }
    }

    private func handleConfirmCheckout() {
        dismissTask?.cancel()
        guard let token = pendingCheckoutToken else {
            dismiss()
            return
        }
        Task {
            try? await APIService.shared.confirmCheckout(token: token)
            await MainActor.run {
                CheckInFeedback.shared.success()
                dismiss()
            }
        }
    }

    private func dismiss() {
        withAnimation { scanResult = nil }
        lastResult = nil
        pendingCheckoutToken = nil
        isProcessing = false
        isScanning = true
        if #available(iOS 16.2, *) { Task { await TicketLiveActivityManager.shared.end() } }
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

// MARK: - Result Overlay (Ticketmaster-style)

struct ScanResultOverlay: View {
    let result: ScanResult
    var onUndo: (() -> Void)? = nil
    var onViewDetails: (() -> Void)? = nil
    var onConfirmCheckout: (() -> Void)? = nil
    var onCancel: (() -> Void)? = nil

    private var accentColor: Color {
        switch result.status {
        case .success, .reentryEnter: return .green
        case .alreadyUsed, .reentryExitPrompt: return Color(red: 1, green: 0.62, blue: 0.1)
        case .error: return .red
        }
    }

    private var statusIcon: String {
        switch result.status {
        case .success, .reentryEnter: return "checkmark.seal.fill"
        case .alreadyUsed, .reentryExitPrompt: return "exclamationmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    private var verifiedLabel: String {
        switch result.status {
        case .success, .reentryEnter: return "Verified Ticket"
        case .alreadyUsed: return "Already Checked In"
        case .reentryExitPrompt: return "Checking Out"
        case .error: return "Invalid Ticket"
        }
    }

    var body: some View {
        ZStack {
            Color.black.opacity(0.9).ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Status pill
                HStack(spacing: 7) {
                    Image(systemName: statusIcon)
                        .font(.system(size: 15, weight: .bold))
                    Text(result.title)
                        .font(.system(size: 15, weight: .bold))
                }
                .foregroundStyle(accentColor)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(accentColor.opacity(0.15), in: Capsule())
                .overlay(Capsule().strokeBorder(accentColor.opacity(0.45), lineWidth: 1))
                .padding(.bottom, 14)

                // Ticket card
                ticketCard
                    .padding(.horizontal, 20)
                    .shadow(color: .black.opacity(0.55), radius: 22, y: 10)

                Spacer()

                // Action buttons
                actionArea
                    .padding(.horizontal, 28)
                    .padding(.bottom, 44)
            }
        }
    }

    // MARK: Card

    private var ticketCard: some View {
        VStack(spacing: 0) {
            ticketHeader
            ticketPerforation
            ticketFooter
        }
        .clipShape(TicketShape())
    }

    // Top section: dark gradient with attendee name, date, and event branding
    private var ticketHeader: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(
                colors: [
                    Color(red: 0.14, green: 0.13, blue: 0.17),
                    Color(red: 0.08, green: 0.08, blue: 0.10)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            VStack(spacing: 0) {
                // Name (top-left) + date (top-right)
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(result.firstName ?? result.name)
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(.white)
                        if let email = result.email {
                            Text(email)
                                .font(.system(size: 11))
                                .foregroundStyle(.white.opacity(0.55))
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(formattedNow())
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white)
                        .multilineTextAlignment(.trailing)
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)

                Spacer()

                // Center event icon + name
                VStack(spacing: 7) {
                    ZStack {
                        Circle()
                            .strokeBorder(.white.opacity(0.65), lineWidth: 1.5)
                            .frame(width: 44, height: 44)
                        Image(systemName: "music.note")
                            .font(.system(size: 18, weight: .medium))
                            .foregroundStyle(.white.opacity(0.9))
                    }
                    if let eventName = result.eventName {
                        Text(eventName.uppercased())
                            .font(.system(size: 13, weight: .bold, design: .rounded))
                            .foregroundStyle(.white)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .padding(.horizontal, 12)
                    }
                }
                .padding(.bottom, 18)
            }
        }
        .frame(height: 172)
    }

    // Perforated divider between header and footer
    private var ticketPerforation: some View {
        ZStack {
            // Gradient bridging the two sections
            LinearGradient(
                colors: [
                    Color(red: 0.14, green: 0.13, blue: 0.17),
                    Color(red: 0.18, green: 0.18, blue: 0.20)
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            // Dashed perforation line
            HStack(spacing: 5) {
                ForEach(0..<20, id: \.self) { _ in
                    Capsule()
                        .fill(Color(white: 0.35))
                        .frame(width: 6, height: 1.5)
                }
            }
        }
        .frame(height: 24)
    }

    // Bottom section: ticket type, section, verified badge
    private var ticketFooter: some View {
        let ticketType = result.customFields?["Ticket Type"]
            ?? result.customFields?["ticket_type"]
            ?? result.customFields?["Type"]
            ?? "GENERAL ADMISSN"
        let section = result.customFields?["Section"]
            ?? result.customFields?["section"]
            ?? result.customFields?["Seat"]
            ?? result.customFields?["Row"]

        return VStack(spacing: 0) {
            HStack(alignment: .bottom) {
                Text(ticketType.uppercased())
                    .font(.system(size: 22, weight: .heavy))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if let sec = section {
                    VStack(alignment: .trailing, spacing: -4) {
                        Text("Sec")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white.opacity(0.6))
                        Text(sec)
                            .font(.system(size: 30, weight: .bold))
                            .foregroundStyle(.white)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)

            // "Verified Resale Ticket  Venue" style secondary info
            if let eventName = result.eventName {
                HStack {
                    Text(verifiedLabel)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                    Spacer()
                    Text(eventName)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
            }

            Divider()
                .background(Color(white: 0.3))
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

            HStack {
                // Verified / status badge
                HStack(spacing: 5) {
                    Image(systemName: statusIcon)
                        .font(.system(size: 12))
                        .foregroundStyle(accentColor)
                    Text(verifiedLabel)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
                Spacer()
                Text("ticket check in")
                    .font(.system(size: 11, weight: .medium))
                    .italic()
                    .foregroundStyle(.white.opacity(0.4))
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 14)

            // "Already used" timestamp
            if let usedAt = result.usedAt, result.status == .alreadyUsed {
                Text("First scanned \(formattedDate(usedAt))")
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.45))
                    .padding(.bottom, 10)
            }
        }
        .background(Color(red: 0.18, green: 0.18, blue: 0.20))
    }

    // MARK: Actions

    @ViewBuilder
    private var actionArea: some View {
        if result.status == .reentryExitPrompt {
            VStack(spacing: 12) {
                if let onConfirmCheckout {
                    Button(action: onConfirmCheckout) {
                        Text("Confirm Check-Out")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(.white, in: RoundedRectangle(cornerRadius: 14))
                    }
                }
                if let onCancel {
                    Button(action: onCancel) {
                        Text("Cancel")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.55))
                    }
                }
            }
        } else {
            HStack(spacing: 12) {
                if let onViewDetails {
                    Button(action: onViewDetails) {
                        Text("View Details")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 22)
                            .padding(.vertical, 11)
                            .background(Color(white: 0.22), in: Capsule())
                    }
                }
                if let onUndo {
                    Button(action: onUndo) {
                        Text("Undo")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 22)
                            .padding(.vertical, 11)
                            .background(Color(white: 0.22), in: Capsule())
                    }
                }
            }
        }
    }

    // MARK: Helpers

    private func formattedNow() -> String {
        let now = Date()
        let d = DateFormatter(); d.dateFormat = "MMM d"
        let t = DateFormatter(); t.dateFormat = "h:mm a"
        return "\(d.string(from: now).uppercased())\n\(t.string(from: now))"
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

// MARK: - Ticket Shape (rounded rect with side notches at perforation)

private struct TicketShape: Shape {
    var cornerRadius: CGFloat = 16
    var notchRadius: CGFloat = 11
    // Fraction of total height where the perforation sits
    var notchRatio: CGFloat = 0.565

    func path(in rect: CGRect) -> Path {
        let ny = rect.height * notchRatio  // Y-centre of notches
        let r = cornerRadius
        let nr = notchRadius

        var p = Path()

        // Top-left arc
        p.move(to: CGPoint(x: r, y: 0))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: 0))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: r), radius: r,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)

        // Right edge → right notch (concave inward)
        p.addLine(to: CGPoint(x: rect.maxX, y: ny - nr))
        p.addArc(center: CGPoint(x: rect.maxX, y: ny), radius: nr,
                 startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: true)

        // Right edge → bottom-right arc
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)

        // Bottom edge
        p.addLine(to: CGPoint(x: r, y: rect.maxY))
        p.addArc(center: CGPoint(x: r, y: rect.maxY - r), radius: r,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)

        // Left edge → left notch (concave inward)
        p.addLine(to: CGPoint(x: 0, y: ny + nr))
        p.addArc(center: CGPoint(x: 0, y: ny), radius: nr,
                 startAngle: .degrees(90), endAngle: .degrees(-90), clockwise: true)

        // Left edge → top-left arc
        p.addLine(to: CGPoint(x: 0, y: r))
        p.addArc(center: CGPoint(x: r, y: r), radius: r,
                 startAngle: .degrees(180), endAngle: .degrees(-90), clockwise: false)

        p.closeSubpath()
        return p
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
