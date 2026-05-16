//
//  TerminalService.swift
//  Ticket Check In
//
//  Wraps the Stripe Terminal SDK for in-app Tap to Pay on iPhone.
//
//  Until the StripeTerminal SwiftPM package is added in Xcode, the bodies fall
//  through to stubs that surface a clear error in the UI — the rest of the app
//  still builds.
//

import Foundation
import Combine

#if canImport(StripeTerminal)
import StripeTerminal
#endif

@MainActor
final class TerminalService: NSObject, ObservableObject {
    static let shared = TerminalService()

    @Published private(set) var status: Status = .idle
    @Published private(set) var lastError: String?

    enum Status: Equatable {
        case idle
        case initializing
        case discoveringReader
        case connectingReader
        case ready
        case creatingPayment
        case waitingForTap
        case processingPayment
        case success(name: String)
        case failed(String)
    }

    private var didConfigureTokenProvider = false

    private override init() {
        super.init()
    }

    /// One-time setup: install the connection-token provider. Safe to call repeatedly.
    func bootstrapIfNeeded() {
        guard !didConfigureTokenProvider else { return }
        didConfigureTokenProvider = true
        #if canImport(StripeTerminal)
        Terminal.setTokenProvider(TokenProvider.shared)
        #endif
    }

    /// Connects the iPhone's built-in Tap-to-Pay reader. Idempotent.
    func ensureReaderConnected() async throws {
        #if canImport(StripeTerminal)
        bootstrapIfNeeded()

        if Terminal.shared.connectionStatus == .connected,
           Terminal.shared.connectedReader?.deviceType == .tapToPay {
            status = .ready
            return
        }

        status = .discoveringReader

        let locationId = try await APIService.shared.fetchTerminalLocationId()

        let config = try TapToPayDiscoveryConfigurationBuilder().build()
        let reader = try await discoverFirstReader(config: config)

        status = .connectingReader

        let connectConfig = try TapToPayConnectionConfigurationBuilder(delegate: ReaderDelegateBox.shared)
            .setLocationId(locationId)
            .build()

        _ = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Reader, Error>) in
            Terminal.shared.connectReader(reader, connectionConfig: connectConfig) { connected, error in
                if let error = error { cont.resume(throwing: error) }
                else if let connected = connected { cont.resume(returning: connected) }
                else { cont.resume(throwing: NSError(domain: "TerminalService", code: -1, userInfo: [NSLocalizedDescriptionKey: "Unknown connect failure"])) }
            }
        }
        status = .ready
        #else
        throw TerminalUnavailableError()
        #endif
    }

    /// Run a full tap-to-pay sale for one ticket: create intent on server,
    /// collect card via Tap to Pay, confirm, finalize. Returns the buyer name on success.
    func chargeAndIssueTicket(eventId: String, name: String, email: String?) async throws -> String {
        #if canImport(StripeTerminal)
        try await ensureReaderConnected()

        status = .creatingPayment
        let pi = try await APIService.shared.createTerminalPaymentIntent(eventId: eventId, name: name, email: email)

        let retrieved: PaymentIntent = try await withCheckedThrowingContinuation { cont in
            Terminal.shared.retrievePaymentIntent(clientSecret: pi.clientSecret) { intent, err in
                if let err = err { cont.resume(throwing: err) }
                else if let intent = intent { cont.resume(returning: intent) }
                else { cont.resume(throwing: NSError(domain: "TerminalService", code: -2)) }
            }
        }

        status = .waitingForTap
        let collected: PaymentIntent = try await withCheckedThrowingContinuation { cont in
            _ = Terminal.shared.collectPaymentMethod(retrieved) { intent, err in
                if let err = err { cont.resume(throwing: err) }
                else if let intent = intent { cont.resume(returning: intent) }
                else { cont.resume(throwing: NSError(domain: "TerminalService", code: -3)) }
            }
        }

        status = .processingPayment
        let _: PaymentIntent = try await withCheckedThrowingContinuation { cont in
            Terminal.shared.confirmPaymentIntent(collected) { intent, err in
                if let err = err { cont.resume(throwing: err) }
                else if let intent = intent { cont.resume(returning: intent) }
                else { cont.resume(throwing: NSError(domain: "TerminalService", code: -4)) }
            }
        }

        let result = try await APIService.shared.finalizeTerminalPayment(paymentIntentId: pi.paymentIntentId)
        let buyerName = result.name ?? name
        status = .success(name: buyerName)
        return buyerName
        #else
        throw TerminalUnavailableError()
        #endif
    }

    func reset() {
        status = .idle
        lastError = nil
    }

    // MARK: - Internals

    #if canImport(StripeTerminal)
    private func discoverFirstReader(config: DiscoveryConfiguration) async throws -> Reader {
        try await withCheckedThrowingContinuation { cont in
            let discovery = DiscoveryBox()
            discovery.onUpdate = { readers in
                if let first = readers.first {
                    discovery.cancelable?.cancel { _ in }
                    if !discovery.resumed {
                        discovery.resumed = true
                        cont.resume(returning: first)
                    }
                }
            }
            discovery.cancelable = Terminal.shared.discoverReaders(config, delegate: discovery) { error in
                if let error = error, !discovery.resumed {
                    discovery.resumed = true
                    cont.resume(throwing: error)
                }
            }
        }
    }
    #endif
}

struct TerminalUnavailableError: LocalizedError {
    var errorDescription: String? {
        "Stripe Terminal SDK isn't installed yet. Add the StripeTerminal Swift package in Xcode to enable Tap to Pay."
    }
}

#if canImport(StripeTerminal)

/// Token provider hands the SDK a fresh server-issued token whenever it asks.
private final class TokenProvider: NSObject, ConnectionTokenProvider {
    static let shared = TokenProvider()
    func fetchConnectionToken(_ completion: @escaping ConnectionTokenCompletionBlock) {
        Task {
            do {
                let token = try await APIService.shared.fetchTerminalConnectionToken()
                completion(token, nil)
            } catch {
                completion(nil, error)
            }
        }
    }
}

/// Captures reader discovery callbacks so we can `await` the first reader.
private final class DiscoveryBox: NSObject, DiscoveryDelegate {
    var cancelable: Cancelable?
    var onUpdate: (([Reader]) -> Void)?
    var resumed = false
    func terminal(_ terminal: Terminal, didUpdateDiscoveredReaders readers: [Reader]) {
        onUpdate?(readers)
    }
}

/// Receives reader-side events. We don't need much from this for Tap to Pay.
private final class ReaderDelegateBox: NSObject, TapToPayReaderDelegate {
    static let shared = ReaderDelegateBox()
    func reader(_ reader: Reader, didReportReaderEvent event: ReaderEvent, info: [AnyHashable : Any]?) {}
    func reader(_ reader: Reader, didStartInstallingUpdate update: ReaderSoftwareUpdate, cancelable: Cancelable?) {}
    func reader(_ reader: Reader, didReportReaderSoftwareUpdateProgress progress: Float) {}
    func reader(_ reader: Reader, didFinishInstallingUpdate update: ReaderSoftwareUpdate?, error: Error?) {}
}

#endif
