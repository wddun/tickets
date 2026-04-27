//
//  DisplayConnectionView.swift
//  Ticket Check In
//
//  Sheet shown from the scanner phone to pair a display device
//  via Bluetooth (BLE) or Internet (SSE QR code).
//

import SwiftUI
import CoreImage.CIFilterBuiltins

struct DisplayConnectionView: View {
    @ObservedObject var bluetooth: BluetoothManager
    @Environment(\.dismiss) private var dismiss

    enum Mode: String, CaseIterable {
        case bluetooth = "Bluetooth"
        case internet  = "Internet"
    }

    @State private var mode: Mode = .bluetooth
    @State private var displayURL: String? = nil
    @State private var isLoadingToken = false
    @State private var tokenError: String? = nil
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()

    private var lastEvent: Event? {
        guard !lastSelectedEventData.isEmpty else { return nil }
        return try? JSONDecoder().decode(Event.self, from: lastSelectedEventData)
    }

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                Picker("Mode", selection: $mode) {
                    ForEach(Mode.allCases, id: \.self) { m in
                        Text(m.rawValue).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)
                .padding(.vertical, 16)

                Divider()

                if mode == .bluetooth {
                    bluetoothContent
                } else {
                    internetContent
                }
            }
            .navigationTitle("Connect Display")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onChange(of: mode) { _ in
            if mode == .bluetooth {
                displayURL = nil
                tokenError = nil
            } else {
                if bluetooth.bleState == .scanning { bluetooth.disconnect() }
                if let event = lastEvent, displayURL == nil { fetchToken(eventId: event.id) }
            }
        }
        .onDisappear {
            if bluetooth.bleState == .scanning { bluetooth.disconnect() }
        }
    }

    // MARK: - Bluetooth

    @ViewBuilder
    private var bluetoothContent: some View {
        ScrollView {
            VStack(spacing: 20) {
                switch bluetooth.bleState {
                case .idle:
                    idleBLE
                case .scanning:
                    scanningBLE
                case .connecting:
                    ProgressView("Connecting…").padding(.top, 40)
                case .connected:
                    connectedBLE
                case .disconnected:
                    VStack(spacing: 16) {
                        Image(systemName: "wifi.slash")
                            .font(.system(size: 44))
                            .foregroundStyle(.secondary)
                        Text("Disconnected — scanning for display…")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        discoveredList
                    }
                case .unauthorized:
                    VStack(spacing: 12) {
                        Image(systemName: "antenna.radiowaves.left.and.right.slash")
                            .font(.system(size: 44))
                            .foregroundStyle(.orange)
                        Text("Bluetooth permission denied")
                            .font(.headline)
                        Text("Go to Settings → Ticket Check In → enable Bluetooth.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                    }.padding(.top, 20)
                case .unsupported:
                    VStack(spacing: 12) {
                        Image(systemName: "xmark.circle")
                            .font(.system(size: 44))
                            .foregroundStyle(.red)
                        Text("Bluetooth not supported on this device.")
                            .font(.headline)
                    }.padding(.top, 20)
                case .advertising:
                    EmptyView()
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
        }
    }

    @ViewBuilder
    private var idleBLE: some View {
        VStack(spacing: 16) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 44))
                .foregroundStyle(.secondary)
                .padding(.top, 20)
            Text("Search for a nearby device running the Display tab.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                bluetooth.startScanningForDisplays()
            } label: {
                Label("Scan for Displays", systemImage: "magnifyingglass")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Color.accentColor)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 32)
        }
    }

    @ViewBuilder
    private var scanningBLE: some View {
        VStack(spacing: 16) {
            HStack(spacing: 10) {
                ProgressView()
                Text("Scanning for displays…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.top, 12)
            if bluetooth.discoveredDisplays.isEmpty {
                Text("On the display device, open the Display tab and tap \"Start Bluetooth Display\".")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            } else {
                discoveredList
            }
        }
    }

    @ViewBuilder
    private var connectedBLE: some View {
        VStack(spacing: 14) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 52))
                .foregroundStyle(.green)
                .padding(.top, 20)
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
    }

    @ViewBuilder
    private var discoveredList: some View {
        if !bluetooth.discoveredDisplays.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Text("NEARBY DISPLAYS")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 6)
                ForEach(bluetooth.discoveredDisplays) { display in
                    Button {
                        bluetooth.connect(to: display)
                    } label: {
                        HStack {
                            Image(systemName: "tv")
                                .font(.system(size: 18))
                                .foregroundStyle(.accentColor)
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
    }

    // MARK: - Internet

    @ViewBuilder
    private var internetContent: some View {
        ScrollView {
            VStack(spacing: 20) {
                if let event = lastEvent {
                    Text(event.name)
                        .font(.headline)
                        .padding(.top, 8)

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
                        Text("Scan this code on the display device")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        if let qrImage = makeQRImage(url) {
                            Image(uiImage: qrImage)
                                .interpolation(.none)
                                .resizable()
                                .scaledToFit()
                                .frame(width: 220, height: 220)
                                .padding(12)
                                .background(.white, in: RoundedRectangle(cornerRadius: 12))
                        }
                        Text(url)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        Button("Refresh") { fetchToken(eventId: event.id) }
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Image(systemName: "calendar.badge.questionmark")
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                        .padding(.top, 20)
                    Text("No event selected")
                        .font(.headline)
                    Text("Open the Events tab, select an event, then come back here to get the display QR code.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 20)
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
                    tokenError = "Could not load display link. Make sure you're logged in."
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
