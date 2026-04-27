//
//  DisplayConnectionView.swift
//  Ticket Check In
//
//  Settings sheet: choose this device's role (Display or Scanner)
//  and connection method (Bluetooth or WiFi), then start.
//

import SwiftUI
import CoreImage.CIFilterBuiltins

struct DisplaySetupView: View {
    @ObservedObject var bluetooth: BluetoothManager
    @Environment(\.dismiss) private var dismiss

    @AppStorage("displayModeActive")   private var displayModeActive   = false
    @AppStorage("displayInitialMode")  private var displayInitialMode  = "bluetooth"
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()

    enum Role       { case display, scanner }
    enum Connection { case bluetooth, wifi }
    enum Phase      { case picking, scannerBLE, scannerWiFi }

    @State private var role:       Role       = .display
    @State private var connection: Connection = .bluetooth
    @State private var phase:      Phase      = .picking

    // Scanner WiFi state
    @State private var displayURL:     String? = nil
    @State private var isLoadingToken          = false
    @State private var tokenError:     String? = nil

    private var lastEvent: Event? {
        guard !lastSelectedEventData.isEmpty else { return nil }
        return try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
    }

    var body: some View {
        NavigationView {
            Group {
                switch phase {
                case .picking:    pickingView
                case .scannerBLE: scannerBLEView
                case .scannerWiFi: scannerWiFiView
                }
            }
            .navigationTitle("Display Setup")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if phase == .picking {
                        Button("Cancel") { dismiss() }
                    } else {
                        Button("Back") {
                            if bluetooth.bleState == .scanning || bluetooth.bleState == .connecting {
                                bluetooth.disconnect()
                            }
                            phase = .picking
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if phase == .scannerBLE && bluetooth.bleState == .connected {
                        Button("Done") { dismiss() }
                    }
                }
            }
        }
    }

    // MARK: - Phase 1: Picker

    @ViewBuilder
    private var pickingView: some View {
        Form {
            Section {
                rolePicker
            } header: {
                Text("This phone is the…")
            }

            Section {
                connectionPicker
            } header: {
                Text("Connect via")
            }

            Section {
                Button {
                    startSetup()
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

            Section {
                Text(description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var rolePicker: some View {
        HStack(spacing: 0) {
            roleButton("Display", selected: role == .display) { role = .display }
            Divider()
            roleButton("Scanner", selected: role == .scanner) { role = .scanner }
        }
        .fixedSize(horizontal: false, vertical: true)
        .listRowInsets(EdgeInsets())
    }

    @ViewBuilder
    private var connectionPicker: some View {
        HStack(spacing: 0) {
            roleButton("Bluetooth", selected: connection == .bluetooth) { connection = .bluetooth }
            Divider()
            roleButton("WiFi", selected: connection == .wifi) { connection = .wifi }
        }
        .fixedSize(horizontal: false, vertical: true)
        .listRowInsets(EdgeInsets())
    }

    @ViewBuilder
    private func roleButton(_ label: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 15, weight: selected ? .semibold : .regular))
                .foregroundStyle(selected ? Color.accentColor : .secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
                .background(selected ? Color.accentColor.opacity(0.08) : Color.clear)
        }
        .buttonStyle(.plain)
    }

    private var description: String {
        switch (role, connection) {
        case (.display, .bluetooth):
            return "This phone shows scan results. The scanner phone finds and connects to it via Bluetooth — no internet needed."
        case (.display, .wifi):
            return "This phone shows scan results via the server. Point its camera at the QR code shown on the scanner phone."
        case (.scanner, .bluetooth):
            return "This phone scans tickets and sends results to the display phone over Bluetooth."
        case (.scanner, .wifi):
            return "This phone scans tickets. Results appear on the display phone via the server — show this QR code on the display phone."
        }
    }

    private func startSetup() {
        switch (role, connection) {
        case (.display, let conn):
            displayInitialMode = conn == .bluetooth ? "bluetooth" : "wifi"
            dismiss()
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 350_000_000)
                displayModeActive = true
            }
        case (.scanner, .bluetooth):
            bluetooth.startScanningForDisplays()
            phase = .scannerBLE
        case (.scanner, .wifi):
            phase = .scannerWiFi
            if let event = lastEvent { fetchToken(eventId: event.id) }
        }
    }

    // MARK: - Phase 2: Scanner BLE

    @ViewBuilder
    private var scannerBLEView: some View {
        ScrollView {
            VStack(spacing: 24) {
                switch bluetooth.bleState {
                case .scanning:
                    VStack(spacing: 12) {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Scanning for displays…")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.top, 24)
                        if bluetooth.discoveredDisplays.isEmpty {
                            Text("On the display phone, open Display Setup → Display → Bluetooth → Start.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 32)
                        } else {
                            bleDeviceList
                        }
                    }

                case .connecting:
                    ProgressView("Connecting…").padding(.top, 40)

                case .connected:
                    VStack(spacing: 14) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 52))
                            .foregroundStyle(.green)
                            .padding(.top, 24)
                        Text("Connected to \(bluetooth.connectedDisplayName ?? "Display")")
                            .font(.headline)
                        Text("Scan results will appear on the display automatically.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button(role: .destructive) {
                            bluetooth.disconnect()
                        } label: {
                            Text("Disconnect")
                                .font(.subheadline)
                                .foregroundStyle(.red)
                        }
                        .padding(.top, 4)
                    }

                case .unauthorized:
                    VStack(spacing: 12) {
                        Image(systemName: "antenna.radiowaves.left.and.right.slash")
                            .font(.system(size: 44))
                            .foregroundStyle(.orange)
                            .padding(.top, 24)
                        Text("Bluetooth permission denied")
                            .font(.headline)
                        Text("Go to Settings → Ticket Check In → enable Bluetooth.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }

                default:
                    EmptyView()
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    @ViewBuilder
    private var bleDeviceList: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("NEARBY DISPLAYS")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 20)
                .padding(.bottom, 6)
            ForEach(bluetooth.discoveredDisplays) { display in
                Button { bluetooth.connect(to: display) } label: {
                    HStack {
                        Image(systemName: "tv")
                            .font(.system(size: 18))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 32)
                        Text(display.name)
                            .font(.system(size: 16, weight: .medium))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
                Divider().padding(.leading, 52)
            }
        }
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 20)
    }

    // MARK: - Phase 2: Scanner WiFi

    @ViewBuilder
    private var scannerWiFiView: some View {
        ScrollView {
            VStack(spacing: 20) {
                if let event = lastEvent {
                    Text(event.name)
                        .font(.headline)
                        .padding(.top, 16)
                    if isLoadingToken {
                        ProgressView("Loading…").padding(.top, 20)
                    } else if let error = tokenError {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 36))
                            .foregroundStyle(.orange)
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                        Button("Retry") { fetchToken(eventId: event.id) }
                    } else if let url = displayURL {
                        Text("Point the display phone's camera at this code")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        if let qrImage = makeQRImage(url) {
                            Image(uiImage: qrImage)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 220, height: 220)
                                .padding(12)
                                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                        }
                        Button("Done") { dismiss() }
                            .font(.system(size: 16, weight: .semibold))
                            .padding(.top, 4)
                    }
                } else {
                    Image(systemName: "calendar.badge.questionmark")
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                        .padding(.top, 24)
                    Text("No event selected")
                        .font(.headline)
                    Text("Open the Events tab and select an event first.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .task(id: lastEvent?.id) {
            guard let event = lastEvent, displayURL == nil, !isLoadingToken else { return }
            fetchToken(eventId: event.id)
        }
    }

    // MARK: - Helpers

    private func fetchToken(eventId: String) {
        isLoadingToken = true
        tokenError = nil
        Task {
            do {
                let (_, url) = try await APIService.shared.getDisplayToken(eventId: eventId)
                await MainActor.run { displayURL = url; isLoadingToken = false }
            } catch {
                await MainActor.run {
                    tokenError = "Could not load display link. Make sure you're signed in."
                    isLoadingToken = false
                }
            }
        }
    }

    private func makeQRImage(_ string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cgImg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cgImg)
    }
}
