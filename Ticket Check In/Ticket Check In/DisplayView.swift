//
//  DisplayView.swift
//  Ticket Check In
//
//  Fullscreen door display — shows scan results big in real time.
//  Supports Bluetooth mode (BLE from scanner phone) and
//  Internet mode (SSE from the ticket server via a display token).
//

import SwiftUI
import AVFoundation

// MARK: - Main View

struct DisplayView: View {
    @ObservedObject var bluetooth: BluetoothManager

    @State private var currentResult: BLEScanResult? = nil
    @State private var resultBg: Color = .black
    @State private var showResult = false
    @State private var dismissTask: Task<Void, Never>? = nil

    // Internet (SSE) mode
    @State private var displayMode: DisplayMode = .bluetooth
    @State private var sseState: SSEState = .idle
    @State private var sseEventName: String = ""
    @State private var sseTotal: Int = 0
    @State private var sseScanned: Int = 0
    @State private var sseClient: SSEDisplayClient? = nil
    @State private var showQRScanner = false

    enum DisplayMode: String, CaseIterable {
        case bluetooth = "Bluetooth"
        case internet  = "Internet"
    }
    enum SSEState { case idle, connecting, connected, disconnected }

    var body: some View {
        GeometryReader { geo in
            let landscape = geo.size.width > geo.size.height
            ZStack {
                resultBg.ignoresSafeArea()
                    .animation(.easeInOut(duration: 0.35), value: showResult)

                if showResult, let result = currentResult {
                    resultContent(result, landscape: landscape)
                        .transition(.opacity)
                } else {
                    idleContent(landscape: landscape)
                        .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.4), value: showResult)
        }
        .ignoresSafeArea()
        .statusBar(hidden: true)
        .modifier(HideSystemOverlaysModifier())
        .onAppear   { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            stopAllConnections()
        }
        // BLE receive
        .onChange(of: bluetooth.receivedResult) { result in
            if let result { displayResult(result) }
        }
        // Internet QR scanner sheet
        .sheet(isPresented: $showQRScanner) {
            DisplayQRScannerSheet { url in
                showQRScanner = false
                connectSSE(urlString: url)
            }
        }
    }

    // MARK: - Idle

    @ViewBuilder
    private func idleContent(landscape: Bool) -> some View {
        VStack(spacing: 0) {
            // Mode picker at top
            if !showResult {
                modePicker
                    .padding(.top, 56)
            }
            Spacer()
            // Status
            VStack(spacing: 10) {
                statusIndicator
                if !sseEventName.isEmpty {
                    Text(sseEventName)
                        .font(.system(size: landscape ? 22 : 18, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.22))
                }
                if sseScanned > 0 {
                    Text("\(sseScanned) / \(sseTotal) checked in")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white.opacity(0.15))
                }
            }
            Spacer()
            // Internet mode: show scan button or connecting state
            if displayMode == .internet && sseState == .idle {
                Button {
                    showQRScanner = true
                } label: {
                    Label("Scan QR Code to Connect", systemImage: "qrcode.viewfinder")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(.white.opacity(0.08), in: Capsule())
                }
                .padding(.bottom, 60)
            } else if displayMode == .bluetooth && bluetooth.bleState == .idle {
                Button { bluetooth.startDisplayMode() } label: {
                    Label("Start Bluetooth Display", systemImage: "antenna.radiowaves.left.and.right")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.7))
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(.white.opacity(0.08), in: Capsule())
                }
                .padding(.bottom, 60)
            } else {
                Spacer().frame(height: 60)
            }
        }
    }

    @ViewBuilder
    private var modePicker: some View {
        Picker("Mode", selection: $displayMode) {
            ForEach(DisplayMode.allCases, id: \.self) { mode in
                Text(mode.rawValue).tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 260)
        .onChange(of: displayMode) { _ in
            stopAllConnections()
        }
    }

    @ViewBuilder
    private var statusIndicator: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(dotColor)
                .frame(width: 9, height: 9)
            Text(statusText)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.white.opacity(0.35))
        }
    }

    private var dotColor: Color {
        switch displayMode {
        case .bluetooth:
            switch bluetooth.bleState {
            case .connected:   return Color.green
            case .advertising: return Color.yellow
            default:           return Color.gray
            }
        case .internet:
            switch sseState {
            case .connected:   return Color.green
            case .connecting:  return Color.yellow
            default:           return Color.gray
            }
        }
    }

    private var statusText: String {
        switch displayMode {
        case .bluetooth:
            switch bluetooth.bleState {
            case .connected:    return "Connected via Bluetooth"
            case .advertising:  return "Waiting for scanner…"
            case .scanning:     return "Scanning…"
            case .connecting:   return "Connecting…"
            case .disconnected: return "Disconnected — retrying…"
            case .unauthorized: return "Bluetooth permission denied"
            case .unsupported:  return "Bluetooth not supported"
            case .idle:         return "Tap to start"
            }
        case .internet:
            switch sseState {
            case .connected:    return "Connected · Live"
            case .connecting:   return "Connecting…"
            case .disconnected: return "Reconnecting…"
            case .idle:         return "Tap to scan QR code"
            }
        }
    }

    // MARK: - Result content

    @ViewBuilder
    private func resultContent(_ result: BLEScanResult, landscape: Bool) -> some View {
        if landscape {
            HStack(spacing: clamp(40, min: 24, max: 80)) {
                Spacer(minLength: 0)
                resultIcon(result).frame(width: 100)
                VStack(alignment: .leading, spacing: 10) {
                    Text(result.firstName ?? result.name)
                        .font(.system(size: 60, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                        .minimumScaleFactor(0.4)
                    Text(resultLabel(result))
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.8))
                }
                Spacer(minLength: 0)
            }
        } else {
            VStack(spacing: 22) {
                Spacer()
                resultIcon(result)
                Text(result.firstName ?? result.name)
                    .font(.system(size: 60, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                    .multilineTextAlignment(.center)
                    .minimumScaleFactor(0.35)
                    .padding(.horizontal, 20)
                Text(resultLabel(result))
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.8))
                Spacer()
                if let event = result.eventName {
                    Text(event)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.white.opacity(0.35))
                        .padding(.bottom, 48)
                }
            }
        }
    }

    @ViewBuilder
    private func resultIcon(_ result: BLEScanResult) -> some View {
        let name: String = {
            switch result.status {
            case "valid", "reentry_enter": return "checkmark.circle.fill"
            case "used":                   return "exclamationmark.circle.fill"
            default:                       return "xmark.circle.fill"
            }
        }()
        Image(systemName: name)
            .font(.system(size: 80, weight: .bold))
            .foregroundStyle(.white)
    }

    private func resultLabel(_ result: BLEScanResult) -> String {
        switch result.status {
        case "valid":         return "Checked In"
        case "reentry_enter": return "Welcome Back"
        case "used":          return "Already Checked In"
        default:              return "Invalid Ticket"
        }
    }

    private func resultBackground(_ result: BLEScanResult) -> Color {
        switch result.status {
        case "valid", "reentry_enter": return Color(red: 0.07, green: 0.53, blue: 0.25)
        case "used":                   return Color(red: 0.75, green: 0.37, blue: 0.06)
        default:                       return Color(red: 0.72, green: 0.12, blue: 0.12)
        }
    }

    // MARK: - Actions

    private func displayResult(_ result: BLEScanResult) {
        dismissTask?.cancel()
        currentResult = result
        resultBg = resultBackground(result)
        withAnimation { showResult = true }
        dismissTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation { showResult = false }
            resultBg = .black
        }
    }

    private func stopAllConnections() {
        bluetooth.disconnect()
        sseClient?.stop()
        sseClient = nil
        sseState = .idle
    }

    private func connectSSE(urlString: String) {
        // Parse the display token from the display.html?token=xxx URL
        guard let url = URL(string: urlString),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
              !token.isEmpty else { return }

        sseState = .connecting
        let client = SSEDisplayClient()
        sseClient = client
        client.onEvent = { [self] msg in
            Task { @MainActor in
                handleSSEMessage(msg)
            }
        }
        client.onStateChange = { [self] connected in
            Task { @MainActor in
                sseState = connected ? .connected : .disconnected
            }
        }
        client.connect(token: token)
    }

    private func handleSSEMessage(_ json: String) {
        guard let data = json.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["type"] as? String else { return }

        if type == "init" {
            if let ev = msg["event"] as? [String: Any] {
                sseEventName = ev["name"] as? String ?? ""
            }
            sseTotal   = msg["total"]   as? Int ?? 0
            sseScanned = msg["scanned"] as? Int ?? 0
        } else if type == "scan" {
            sseTotal   = msg["total"]   as? Int ?? sseTotal
            sseScanned = msg["scanned"] as? Int ?? sseScanned
            let result = BLEScanResult(
                status:    msg["status"]    as? String ?? "invalid",
                name:      msg["name"]      as? String ?? "Guest",
                firstName: nil,
                eventName: sseEventName.isEmpty ? nil : sseEventName
            )
            displayResult(result)
        }
    }

    private func clamp(_ value: CGFloat, min: CGFloat, max: CGFloat) -> CGFloat {
        Swift.max(min, Swift.min(max, value))
    }
}

// MARK: - SSE Client (Internet mode)

class SSEDisplayClient: NSObject, URLSessionDataDelegate {
    var onEvent: ((String) -> Void)?
    var onStateChange: ((Bool) -> Void)?

    private var session: URLSession?
    private var retryDelay: TimeInterval = 2
    private var isStopped = false
    private var token = ""

    func connect(token: String) {
        self.token = token
        startStream()
    }

    private func startStream() {
        guard !isStopped else { return }
        guard let url = URL(string: "\(baseURL)/api/display/stream/\(token)") else { return }
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = .infinity
        config.timeoutIntervalForResource = .infinity
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session?.dataTask(with: url).resume()
    }

    func stop() {
        isStopped = true
        session?.invalidateAndCancel()
        session = nil
    }

    // MARK: URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        retryDelay = 2
        onStateChange?(true)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        for line in text.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("data: ") {
                let json = String(trimmed.dropFirst(6))
                onEvent?(json)
            }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask,
                    didCompleteWithError error: Error?) {
        onStateChange?(false)
        guard !isStopped else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) { [weak self] in
            guard let self, !self.isStopped else { return }
            self.session = nil
            self.startStream()
        }
        retryDelay = min(retryDelay * 2, 8)
    }
}

// MARK: - QR Scanner Sheet (for Internet mode pairing)

private struct HideSystemOverlaysModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16.0, *) {
            content.persistentSystemOverlays(.hidden)
        } else {
            content
        }
    }
}

struct DisplayQRScannerSheet: View {
    let onDetected: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationView {
            ZStack {
                Color.black.ignoresSafeArea()
                DisplayQRCameraView(onDetected: onDetected)
                VStack {
                    Spacer()
                    Text("Point camera at the QR code on the scanner device")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.bottom, 48)
                }
            }
            .navigationTitle("Scan Display QR")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(.white)
                }
            }
            .modifier(DarkNavBarModifier())
        }
        .navigationViewStyle(.stack)
    }
}

private struct DarkNavBarModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 16.0, *) {
            content
                .toolbarBackground(.black, for: .navigationBar)
                .toolbarColorScheme(.dark, for: .navigationBar)
        } else {
            content
        }
    }
}

struct DisplayQRCameraView: UIViewRepresentable {
    let onDetected: (String) -> Void

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .black
        let session = AVCaptureSession()
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { return view }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        if session.canAddOutput(output) {
            session.addOutput(output)
            output.setMetadataObjectsDelegate(context.coordinator, queue: .main)
            output.metadataObjectTypes = [.qr]
        }
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.videoGravity = .resizeAspectFill
        preview.frame = UIScreen.main.bounds
        view.layer.addSublayer(preview)
        context.coordinator.session = session
        DispatchQueue.global(qos: .userInitiated).async { session.startRunning() }
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onDetected: onDetected) }

    class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var session: AVCaptureSession?
        let onDetected: (String) -> Void
        private var fired = false

        init(onDetected: @escaping (String) -> Void) { self.onDetected = onDetected }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput objects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !fired,
                  let obj = objects.first as? AVMetadataMachineReadableCodeObject,
                  let code = obj.stringValue, !code.isEmpty else { return }
            fired = true
            session?.stopRunning()
            DispatchQueue.main.async { self.onDetected(code) }
        }
    }
}
