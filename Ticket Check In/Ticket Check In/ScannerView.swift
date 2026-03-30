//
//  ScannerView.swift
//  Ticket Check In
//
//  Created by William Dunning on 3/24/26.
//

import SwiftUI
import AVFoundation
import AudioToolbox

struct ScannerView: View {
    let switchToManual: () -> Void

    @State private var scanResult: ScanResult?
    @State private var isScanning = true
    @State private var isProcessing = false
    @State private var lastRegistrationId: String?
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            CameraPreviewView(isScanning: $isScanning, onCode: handleCode)
                .ignoresSafeArea()

            // Viewfinder frame
            VStack {
                Spacer()
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.white.opacity(0.7), lineWidth: 3)
                    .frame(width: 260, height: 260)
                Spacer()
                Spacer()
            }

            // Result overlay
            if let result = scanResult {
                ScanResultOverlay(result: result, onUndo: result.status == .success ? handleUndo : nil)
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.2), value: scanResult != nil)
            }

            // Manual check-in button
            VStack {
                Spacer()
                Button(action: switchToManual) {
                    Label("Manual Check-in", systemImage: "person.text.rectangle")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(.ultraThinMaterial, in: Capsule())
                }
                .padding(.bottom, 40)
            }
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
    }

    private func handleCode(_ token: String) {
        guard !isProcessing else { return }
        isProcessing = true
        isScanning = false

        Task {
            do {
                let response = try await APIService.shared.validateTicket(token: token)
                await MainActor.run {
                    showResult(for: response)
                }
            } catch {
                await MainActor.run {
                    scanResult = ScanResult(status: .error, title: "Error", subtitle: error.localizedDescription)
                    CheckInFeedback.shared.error()
                    scheduleDismiss()
                }
            }
        }
    }

    private func showResult(for response: ValidateResponse) {
        switch response.status {
        case "valid":
            let name = response.name ?? "Guest"
            lastRegistrationId = response.registrationId ?? response.ticketId
            scanResult = ScanResult(status: .success, title: "Checked In!", subtitle: name)
            CheckInFeedback.shared.success()
        case "used":
            let name = response.name ?? "Guest"
            scanResult = ScanResult(status: .alreadyUsed, title: "Already Checked In", subtitle: name)
            CheckInFeedback.shared.alreadyUsed()
        default:
            scanResult = ScanResult(status: .error, title: "Invalid Ticket", subtitle: response.message ?? "")
            CheckInFeedback.shared.error()
        }
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
            withAnimation { scanResult = nil }
            isProcessing = false
            isScanning = true
            return
        }
        Task {
            try? await APIService.shared.undoCheckIn(registrationId: registrationId)
            await MainActor.run {
                withAnimation { scanResult = nil }
                isProcessing = false
                isScanning = true
            }
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

// MARK: - Scan Result Model

struct ScanResult: Equatable {
    enum Status { case success, alreadyUsed, error }
    let status: Status
    let title: String
    let subtitle: String
}

// MARK: - Result Overlay

struct ScanResultOverlay: View {
    let result: ScanResult
    var onUndo: (() -> Void)? = nil

    var overlayColor: Color {
        switch result.status {
        case .success: return .green
        case .alreadyUsed: return .orange
        case .error: return .red
        }
    }

    var icon: String {
        switch result.status {
        case .success: return "checkmark.circle.fill"
        case .alreadyUsed: return "exclamationmark.circle.fill"
        case .error: return "xmark.circle.fill"
        }
    }

    var body: some View {
        ZStack {
            overlayColor.opacity(0.85).ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.system(size: 72))
                    .foregroundStyle(.white)
                Text(result.title)
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.white)
                if !result.subtitle.isEmpty {
                    Text(result.subtitle)
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(.white.opacity(0.9))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }
                if let onUndo {
                    Button(action: onUndo) {
                        Text("Undo")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(overlayColor)
                            .padding(.horizontal, 28)
                            .padding(.vertical, 10)
                            .background(.white.opacity(0.9), in: Capsule())
                    }
                    .padding(.top, 8)
                }
            }
        }
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

    // UIView subclass so layoutSubviews keeps preview layer sized correctly
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
