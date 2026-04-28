//
//  BluetoothManager.swift
//  Ticket Check In
//

import Combine
import CoreBluetooth
import UIKit

// JSON payload sent over BLE from scanner phone → display phone
struct BLEScanResult: Codable, Equatable {
    let status: String      // "valid" | "used" | "invalid" | "reentry_enter" | "reentry_exit" | "ping"
    let name: String
    let firstName: String?
    let eventName: String?
    let registrationId: String?

    init(status: String, name: String, firstName: String? = nil,
         eventName: String? = nil, registrationId: String? = nil) {
        self.status = status
        self.name = name
        self.firstName = firstName
        self.eventName = eventName
        self.registrationId = registrationId
    }
}

class BluetoothManager: NSObject, ObservableObject {
    static let shared = BluetoothManager()

    // GATT identifiers — must match on both devices
    static let serviceUUID        = CBUUID(string: "E7D7A9F0-1234-5678-ABCD-EF0123456789")
    static let characteristicUUID = CBUUID(string: "E7D7A9F1-1234-5678-ABCD-EF0123456789")

    // MARK: - Published State

    enum Role { case none, scanner, display }

    enum BLEState: Equatable {
        case idle
        case scanning        // central scanning for peripherals
        case advertising     // peripheral advertising, waiting for scanner
        case connecting
        case connected
        case disconnected
        case unauthorized    // user denied Bluetooth permission
        case unsupported     // hardware doesn't support BLE
    }

    @Published var role: Role = .none
    @Published var bleState: BLEState = .idle
    @Published var discoveredDisplays: [DiscoveredDisplay] = []
    @Published var connectedDisplayName: String? = nil
    @Published var receivedResult: BLEScanResult? = nil

    struct DiscoveredDisplay: Identifiable {
        let id: UUID
        let peripheral: CBPeripheral
        var name: String { peripheral.name ?? "WTS Display" }
    }

    // MARK: - Private

    private var centralManager: CBCentralManager?
    private var peripheralManager: CBPeripheralManager?
    private var connectedPeripheral: CBPeripheral?
    private var writeCharacteristic: CBCharacteristic?
    private var notifyCharacteristic: CBMutableCharacteristic?

    // MARK: - Public API

    /// Call on the phone that will ACT AS the display (shows scan results).
    func startDisplayMode() {
        guard role != .display else { return }
        role = .display
        bleState = .advertising
        // Creating CBPeripheralManager triggers delegate callbacks
        peripheralManager = CBPeripheralManager(delegate: self, queue: .main)
    }

    /// Call on the scanner phone to search for nearby display phones.
    func startScanningForDisplays() {
        guard role != .scanner else { return }
        role = .scanner
        bleState = .scanning
        discoveredDisplays = []
        centralManager = CBCentralManager(delegate: self, queue: .main)
    }

    /// Connect the scanner to a discovered display phone.
    func connect(to display: DiscoveredDisplay) {
        guard let central = centralManager else { return }
        bleState = .connecting
        connectedPeripheral = display.peripheral
        display.peripheral.delegate = self
        central.stopScan()
        central.connect(display.peripheral, options: nil)
    }

    /// Send a scan result to the paired display phone.
    func sendScanResult(_ result: BLEScanResult) {
        guard role == .scanner,
              let peripheral = connectedPeripheral,
              let characteristic = writeCharacteristic,
              let data = try? JSONEncoder().encode(result) else { return }
        write(data: data, to: peripheral, characteristic: characteristic)
    }

    /// Send a connection ping so the display immediately shows "connected".
    func sendPing() {
        let ping = BLEScanResult(
            status: "ping",
            name: UIDevice.current.name,
            firstName: nil,
            eventName: nil
        )
        guard let data = try? JSONEncoder().encode(ping) else { return }
        guard let peripheral = connectedPeripheral,
              let characteristic = writeCharacteristic else { return }
        write(data: data, to: peripheral, characteristic: characteristic)
    }

    /// Send a check-in command from display to scanner phone.
    func sendCheckInCommand() {
        guard role == .display, let char = notifyCharacteristic else { return }
        let cmd = BLEScanResult(status: "checkin_cmd", name: "", firstName: nil, eventName: nil, registrationId: nil)
        guard let data = try? JSONEncoder().encode(cmd) else { return }
        peripheralManager?.updateValue(data, for: char, onSubscribedCentrals: nil)
    }

    /// Send a check-out command from display to scanner phone.
    func sendCheckoutCommand() {
        guard role == .display, let char = notifyCharacteristic else { return }
        let cmd = BLEScanResult(status: "checkout_cmd", name: "", firstName: nil, eventName: nil, registrationId: nil)
        guard let data = try? JSONEncoder().encode(cmd) else { return }
        peripheralManager?.updateValue(data, for: char, onSubscribedCentrals: nil)
    }

    private func write(data: Data, to peripheral: CBPeripheral, characteristic: CBCharacteristic) {
        let type: CBCharacteristicWriteType = characteristic.properties.contains(.writeWithoutResponse)
            ? .withoutResponse
            : .withResponse
        peripheral.writeValue(data, for: characteristic, type: type)
    }

    /// Stop all Bluetooth activity and reset state.
    func disconnect() {
        if let p = connectedPeripheral {
            centralManager?.cancelPeripheralConnection(p)
        }
        peripheralManager?.stopAdvertising()
        peripheralManager?.removeAllServices()
        peripheralManager = nil
        centralManager?.stopScan()
        centralManager = nil

        role = .none
        bleState = .idle
        discoveredDisplays = []
        connectedPeripheral = nil
        writeCharacteristic = nil
        notifyCharacteristic = nil
        connectedDisplayName = nil
    }
}

// MARK: - Peripheral Manager (Display phone — advertises and receives data)

extension BluetoothManager: CBPeripheralManagerDelegate {
    func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
        switch peripheral.state {
        case .poweredOn:
            setupPeripheralService(peripheral)
        case .poweredOff:
            bleState = .idle
        case .unauthorized:
            bleState = .unauthorized
        case .unsupported:
            bleState = .unsupported
        default:
            break
        }
    }

    private func setupPeripheralService(_ manager: CBPeripheralManager) {
        let characteristic = CBMutableCharacteristic(
            type: Self.characteristicUUID,
            properties: [.write, .writeWithoutResponse, .notify],
            value: nil,
            permissions: [.writeable, .readable]
        )
        notifyCharacteristic = characteristic

        let service = CBMutableService(type: Self.serviceUUID, primary: true)
        service.characteristics = [characteristic]
        manager.add(service)
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard error == nil else { bleState = .idle; return }
        peripheral.startAdvertising([
            CBAdvertisementDataServiceUUIDsKey: [Self.serviceUUID],
            CBAdvertisementDataLocalNameKey: "WTS Display"
        ])
    }

    func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
        bleState = error == nil ? .advertising : .idle
    }

    func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        for request in requests {
            guard let data = request.value,
                  let result = try? JSONDecoder().decode(BLEScanResult.self, from: data) else {
                peripheral.respond(to: request, withResult: .invalidAttributeValueLength)
                continue
            }
            peripheral.respond(to: request, withResult: .success)
            // Ping = connection handshake, just mark connected
            if result.status == "ping" {
                bleState = .connected
                connectedDisplayName = result.name
                continue
            }
            receivedResult = result
            if bleState != .connected { bleState = .connected }
        }
    }

    func peripheralManager(_ peripheral: CBPeripheralManager,
                           central: CBCentral, didSubscribeTo characteristic: CBCharacteristic) {
        bleState = .connected
        connectedDisplayName = "Scanner"
    }

    func peripheralManager(_ peripheral: CBPeripheralManager,
                           central: CBCentral, didUnsubscribeFrom characteristic: CBCharacteristic) {
        bleState = .advertising
        connectedDisplayName = nil
    }
}

// MARK: - Central Manager (Scanner phone — discovers and connects to display)

extension BluetoothManager: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn:
            central.scanForPeripherals(
                withServices: [Self.serviceUUID],
                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
            )
        case .poweredOff:
            bleState = .idle
        case .unauthorized:
            bleState = .unauthorized
        case .unsupported:
            bleState = .unsupported
        default:
            break
        }
    }

    func centralManager(_ central: CBCentralManager,
                        didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any],
                        rssi RSSI: NSNumber) {
        let id = peripheral.identifier
        if !discoveredDisplays.contains(where: { $0.id == id }) {
            discoveredDisplays.append(DiscoveredDisplay(id: id, peripheral: peripheral))
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        bleState = .connected
        connectedDisplayName = peripheral.name ?? "Display"
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager,
                        didFailToConnect peripheral: CBPeripheral, error: Error?) {
        bleState = .scanning
        connectedPeripheral = nil
        // Restart scanning so the user can retry
        central.scanForPeripherals(withServices: [Self.serviceUUID], options: nil)
    }

    func centralManager(_ central: CBCentralManager,
                        didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        bleState = .disconnected
        connectedPeripheral = nil
        writeCharacteristic = nil
        connectedDisplayName = nil
        // Auto-reconnect scan after 2 seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            guard self?.role == .scanner, central.state == .poweredOn else { return }
            central.scanForPeripherals(withServices: [Self.serviceUUID], options: nil)
            self?.bleState = .scanning
        }
    }
}

// MARK: - Peripheral Delegate (Scanner phone — discovers GATT services/characteristics)

extension BluetoothManager: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID })
        else { return }
        peripheral.discoverCharacteristics([Self.characteristicUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard let char = service.characteristics?.first(where: { $0.uuid == Self.characteristicUUID })
        else { return }
        writeCharacteristic = char
        peripheral.setNotifyValue(true, for: char)
        // Send ping immediately so display shows connected without waiting for a scan
        sendPing()
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value,
              let cmd = try? JSONDecoder().decode(BLEScanResult.self, from: data) else { return }
        if cmd.status == "checkout_cmd" || cmd.status == "checkin_cmd" {
            DispatchQueue.main.async {
                self.receivedResult = cmd
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral,
                    didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            print("[BLE] Write error: \(error.localizedDescription)")
        }
    }
}
