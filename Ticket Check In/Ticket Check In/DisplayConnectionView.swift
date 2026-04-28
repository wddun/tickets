//
//  DisplayConnectionView.swift
//  Ticket Check In
//

import SwiftUI
import CoreImage.CIFilterBuiltins

struct DisplaySetupView: View {
    @ObservedObject var bluetooth: BluetoothManager
    @Environment(\.dismiss) private var dismiss

    @AppStorage("displayModeActive")      private var displayModeActive   = false
    @AppStorage("displayInitialMode")     private var displayInitialMode  = "bluetooth"
    @AppStorage("displayAutoStart")       private var displayAutoStart    = false
    @AppStorage("lastSelectedEventData")  private var lastSelectedEventData: Data = Data()
    @AppStorage("scannerPairToken")       private var scannerPairToken: String = ""

    enum Role:       String, CaseIterable { case display = "Display", scanner = "Scanner" }
    enum Connection: String, CaseIterable { case bluetooth = "Bluetooth", wifi = "WiFi" }

    @State private var role:       Role       = .display
    @State private var connection: Connection = .bluetooth
    @State private var started                = false

    // Scanner WiFi state
    @State private var displayURL:    String? = nil
    @State private var isLoadingToken         = false
    @State private var tokenError:    String? = nil

    private var lastEvent: Event? {
        guard !lastSelectedEventData.isEmpty else { return nil }
        return try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
    }

    var body: some View {
        NavigationView {
            Form {
                // ── Role ──────────────────────────────────────────────────────
                Section("This device") {
                    Picker("Role", selection: $role) {
                        ForEach(Role.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                    .onChange(of: role) { _ in resetStarted() }
                }

                // ── Connection ────────────────────────────────────────────────
                Section("Connect via") {
                    Picker("Connection", selection: $connection) {
                        ForEach(Connection.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                    .onChange(of: connection) { _ in resetStarted() }
                }

                // ── Start button ──────────────────────────────────────────────
                if !started {
                    Section {
                        Button {
                            handleStart()
                        } label: {
                            HStack {
                                Spacer()
                                Text("Start")
                                    .font(.system(size: 16, weight: .semibold))
                                    .foregroundStyle(Color.accentColor)
                                Spacer()
                            }
                        }
                    }
                }

                // ── Inline connection status (scanner roles only) ──────────────
                if started && role == .scanner {
                    if connection == .bluetooth {
                        bleSection
                    } else {
                        wifiSection
                    }
                }

                // ── Description ───────────────────────────────────────────────
                Section {
                    Text(descriptionText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Display Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        if bluetooth.bleState == .scanning || bluetooth.bleState == .connecting {
                            bluetooth.disconnect()
                        }
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if started && role == .scanner && bluetooth.bleState == .connected {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }
        .onDisappear {
            if bluetooth.bleState == .scanning { bluetooth.disconnect() }
        }
    }

    // MARK: - BLE Section (inline, scanner role)

    @ViewBuilder
    private var bleSection: some View {
        Section {
            switch bluetooth.bleState {
            case .scanning:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Scanning for displays…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
                if bluetooth.discoveredDisplays.isEmpty {
                    Text("On the display phone, open Display Setup → Display → Bluetooth → Start.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

            case .connecting:
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Connecting…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)

            case .connected:
                Label("Connected to \(bluetooth.connectedDisplayName ?? "Display")", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.system(size: 15, weight: .medium))
                    .padding(.vertical, 4)
                Button(role: .destructive) {
                    bluetooth.disconnect()
                    started = false
                } label: {
                    Text("Disconnect")
                        .font(.subheadline)
                }

            case .unauthorized:
                Label("Bluetooth permission denied — check Settings.", systemImage: "antenna.radiowaves.left.and.right.slash")
                    .foregroundStyle(.orange)
                    .font(.subheadline)

            default:
                EmptyView()
            }
        } header: {
            Text("Bluetooth")
        }

        // Discovered devices list
        if !bluetooth.discoveredDisplays.isEmpty &&
           (bluetooth.bleState == .scanning || bluetooth.bleState == .disconnected) {
            Section("Nearby Displays") {
                ForEach(bluetooth.discoveredDisplays) { display in
                    Button {
                        bluetooth.connect(to: display)
                    } label: {
                        HStack {
                            Image(systemName: "tv")
                                .foregroundStyle(Color.accentColor)
                            Text(display.name)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .foregroundStyle(.primary)
                }
            }
        }
    }

    // MARK: - WiFi Section (inline, scanner role)

    @ViewBuilder
    private var wifiSection: some View {
        Section {
            if let event = lastEvent {
                if isLoadingToken {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading…").foregroundStyle(.secondary)
                    }
                } else if let error = tokenError {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(error).foregroundStyle(.secondary).font(.subheadline)
                        Button("Retry") { fetchToken(eventId: event.id) }
                    }
                } else if let url = displayURL {
                    VStack(spacing: 12) {
                        Text("Point the display device at this code")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .center)
                        if let qrImage = makeQRImage(url) {
                            Image(uiImage: qrImage)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: 200)
                                .padding(10)
                                .background(.white, in: RoundedRectangle(cornerRadius: 10))
                                .frame(maxWidth: .infinity)
                        }
                        Text("Scan with any phone's camera app to open the display in a browser — or scan with the iOS Tickets app (Display Setup → Display → WiFi → Start).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.vertical, 8)
                }
            } else {
                Text("Open the Events tab and select an event first.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(lastEvent.map { $0.name } ?? "WiFi")
        }
        .task(id: lastEvent?.id) {
            if let event = lastEvent, displayURL == nil, !isLoadingToken { fetchToken(eventId: event.id) }
        }
    }

    // MARK: - Actions

    private func handleStart() {
        switch (role, connection) {
        case (.display, let conn):
            displayInitialMode = conn == .bluetooth ? "bluetooth" : "wifi"
            displayAutoStart   = true
            dismiss()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                displayModeActive = true
            }
        case (.scanner, .bluetooth):
            bluetooth.startScanningForDisplays()
            started = true
        case (.scanner, .wifi):
            started = true
            if let event = lastEvent { fetchToken(eventId: event.id) }
        }
    }

    private func resetStarted() {
        guard started else { return }
        if bluetooth.bleState == .scanning || bluetooth.bleState == .connecting {
            bluetooth.disconnect()
        }
        started = false
        displayURL = nil
        tokenError = nil
    }

    // MARK: - Description

    private var descriptionText: String {
        switch (role, connection) {
        case (.display, .bluetooth):
            return "This device shows scan results. The scanner phone connects to it via Bluetooth — no internet required on either device."
        case (.display, .wifi):
            return "This device shows scan results via the server. On the scanner phone, go to Display Setup → Scanner → WiFi and point its QR code at this device's camera."
        case (.scanner, .bluetooth):
            return "This device scans tickets and sends results to the display device over Bluetooth."
        case (.scanner, .wifi):
            return "This device scans tickets. Results appear on the display device via the server. Show the QR code below to the display device."
        }
    }

    // MARK: - Helpers

    private func fetchToken(eventId: String) {
        isLoadingToken = true
        tokenError     = nil
        if scannerPairToken.isEmpty { scannerPairToken = UUID().uuidString }
        Task {
            do {
                let (_, baseURL) = try await APIService.shared.getDisplayToken(eventId: eventId)
                let url = baseURL + "&pair=" + scannerPairToken
                await MainActor.run { displayURL = url; isLoadingToken = false }
            } catch {
                await MainActor.run {
                    tokenError     = "Could not load display link. Make sure you're signed in."
                    isLoadingToken = false
                }
            }
        }
    }

    private func makeQRImage(_ string: String) -> UIImage? {
        let context = CIContext()
        let filter  = CIFilter.qrCodeGenerator()
        filter.message         = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImg)
    }
}
