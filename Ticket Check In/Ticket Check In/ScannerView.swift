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

    // Full-screen overlay state (reentry exit confirm only)
    @State private var scanResult: ScanResult?
    // Slide-down banner state
    @State private var bannerResult: ScanResult?
    @State private var bannerVisible = false
    // History strip at bottom
    @State private var recentScans: [ScanResult] = []
    @State private var isScanning = true
    @State private var lastRegistrationId: String?
    @State private var bannerDismissTask: Task<Void, Never>?
    @State private var showingDetail = false
    @State private var lastScannedToken: String?
    @State private var lastScanTime: Date?
    @State private var pendingCheckoutToken: String?
    private let scanDebounceInterval: TimeInterval = 5.0

    var body: some View {
        ZStack {
            CameraPreviewView(isScanning: $isScanning, onCode: handleCode)
                .ignoresSafeArea()
            viewfinderFrame
            bottomBar
            // Slide-down banner — non-blocking, camera stays live
            VStack {
                if bannerVisible, let result = bannerResult {
                    ScanBanner(result: result)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                Spacer()
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
            .animation(.spring(response: 0.32, dampingFraction: 0.78), value: bannerVisible)
            // Full-screen overlay only for reentry exit confirmation
            exitConfirmOverlay
        }
        .task { await api.checkAuth() }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sheet(isPresented: $showingDetail) {
            if let result = recentScans.first {
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
                // Last scan chip
                ForEach(Array(recentScans.prefix(1).enumerated()), id: \.offset) { idx, scan in
                    Button(action: { showingDetail = true }) {
                        HStack(spacing: 8) {
                            let isGreen = scan.status == .success || scan.status == .reentryEnter
                            Circle()
                                .fill(isGreen ? Color.green : Color(red: 0.9, green: 0.5, blue: 0.1))
                                .frame(width: 8, height: 8)
                            Text(scan.firstName ?? scan.name)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text("· \(scan.title)")
                                .font(.system(size: 13))
                                .foregroundStyle(.white.opacity(0.55))
                                .lineLimit(1)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.black.opacity(0.55), in: Capsule())
                    }
                    .opacity(1.0 - Double(idx) * 0.22)
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
                let response = try await APIService.shared.validateTicket(token: token)
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
        case "reentry_enter":
            lastRegistrationId = response.registrationId ?? response.ticketId
            result = ScanResult(from: response, status: .reentryEnter, title: "Checked Back In!")
            CheckInFeedback.shared.success()
            showBanner(result)
        case "reentry_exit":
            pendingCheckoutToken = token
            result = ScanResult(from: response, status: .reentryExitPrompt, title: "Confirm Check-Out")
            CheckInFeedback.shared.alreadyUsed()
            withAnimation { scanResult = result }
            // No banner — full-screen prompt requires explicit action
        case "used":
            result = ScanResult(from: response, status: .alreadyUsed, title: "Already Checked In")
            CheckInFeedback.shared.alreadyUsed()
            showBanner(result)
        default:
            result = ScanResult(status: .error, title: "Invalid Ticket", name: response.name ?? "")
            CheckInFeedback.shared.error()
            showBanner(result)
        }
    }

    private func showBanner(_ result: ScanResult) {
        recentScans.insert(result, at: 0)
        if recentScans.count > 1 { recentScans.removeLast() }
        bannerResult = result
        withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
            bannerVisible = true
        }
        bannerDismissTask?.cancel()
        bannerDismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: 0.22)) { bannerVisible = false }
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

// MARK: - Slide-Down Scan Banner

struct ScanBanner: View {
    let result: ScanResult

    private var color: Color {
        switch result.status {
        case .success, .reentryEnter: return Color(red: 0.09, green: 0.64, blue: 0.29)
        case .alreadyUsed, .reentryExitPrompt: return Color(red: 0.9, green: 0.5, blue: 0.1)
        case .error: return Color(red: 0.86, green: 0.15, blue: 0.15)
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
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 2) {
                Text(result.firstName ?? result.name)
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                Text(result.title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.8))
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 14)
        .background(color)
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
