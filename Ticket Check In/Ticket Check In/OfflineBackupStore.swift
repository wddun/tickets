//
//  OfflineBackupStore.swift
//  Ticket Check In
//
//  The scanner's local copy of an event's guest list, for when the server
//  can't be reached. Only used when the organiser has turned on offline
//  backup for the event (dashboard → settings).
//
//  The server is always asked first; ScannerView only comes here once
//  /api/validate has failed or hasn't answered within the event's
//  offlineFallbackMs. Check-ins made against the copy are queued on disk and
//  replayed through /api/event/:id/offline-sync when the connection is back.
//  The queue is kept even if the setting is switched off or the event is
//  changed, so nothing that already happened at the door is thrown away.
//

import Foundation
import Combine
import CryptoKit
import Network

@MainActor
final class OfflineBackupStore: ObservableObject {
    static let shared = OfflineBackupStore()

    /// The copy for the event this scanner is currently working, if any.
    @Published private(set) var snapshot: OfflineSnapshot?
    @Published private(set) var queue: [OfflineQueuedScan] = []
    @Published private(set) var lastError: String?
    /// Set after a sync, for ScannerView to show as a banner and clear.
    @Published var syncReport: String?

    private var index: [String: Int] = [:]
    private var syncing = false
    private let pathMonitor = NWPathMonitor()

    private init() {
        queue = (try? JSONDecoder().decode([OfflineQueuedScan].self, from: Data(contentsOf: queueURL))) ?? []
        // Sync as soon as the connection comes back rather than waiting for
        // the next 30s tick.
        pathMonitor.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in await OfflineBackupStore.shared.flush() }
        }
        pathMonitor.start(queue: DispatchQueue(label: "OfflineBackupStore.path"))
    }

    // MARK: - Storage

    private var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("OfflineBackup", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    private var queueURL: URL { directory.appendingPathComponent("queue.json") }
    private func snapshotURL(_ eventId: String) -> URL {
        let safe = eventId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? eventId
        return directory.appendingPathComponent("snapshot-\(safe).json")
    }

    private func write(_ data: Data, to url: URL) {
        // Readable after first unlock, so a phone left locked in a pocket
        // between shifts can still scan the moment it's opened.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func saveQueue() {
        if let data = try? JSONEncoder().encode(queue) { write(data, to: queueURL) }
    }

    private func saveSnapshot() {
        guard let snapshot, let data = try? JSONEncoder().encode(snapshot) else { return }
        write(data, to: snapshotURL(snapshot.eventId))
    }

    // MARK: - The copy

    func isReady(for eventId: String?) -> Bool {
        guard let eventId else { return false }
        return snapshot?.eventId == eventId
    }

    /// Loads this event's copy from disk, if there is one — works with no
    /// connection at all, which is the point.
    func load(eventId: String?) {
        guard let eventId else { setSnapshot(nil); return }
        if snapshot?.eventId == eventId { return }
        let stored = try? JSONDecoder().decode(OfflineSnapshot.self, from: Data(contentsOf: snapshotURL(eventId)))
        setSnapshot(stored)
    }

    func drop(eventId: String) {
        try? FileManager.default.removeItem(at: snapshotURL(eventId))
        if snapshot?.eventId == eventId { setSnapshot(nil) }
    }

    private func setSnapshot(_ new: OfflineSnapshot?) {
        guard var new else { snapshot = nil; index = [:]; return }
        index = Dictionary(new.tickets.enumerated().map { ($0.element.h, $0.offset) }, uniquingKeysWith: { a, _ in a })
        // Anything this device did that the server hasn't confirmed yet still
        // counts — a fresh copy must not forget it and let them in twice.
        for q in queue where q.eventId == new.eventId {
            guard let i = index[q.h] else { continue }
            if q.kind == "checkin", new.tickets[i].usedAt == nil { new.tickets[i].usedAt = q.scannedAt }
            if new.allowReentry == true { new.tickets[i].reentryStatus = "inside" }
        }
        snapshot = new
    }

    /// Sends anything queued, then downloads a fresh copy. Called on the
    /// scanner's 30s heartbeat and whenever the event or setting changes.
    func refresh(eventId: String?, enabled: Bool, scanLinkToken: String?) async {
        guard let eventId else { return }
        guard enabled else {
            drop(eventId: eventId)
            await flush()
            return
        }
        load(eventId: eventId)
        await flush()
        do {
            var fresh = try await APIService.shared.fetchOfflineSnapshot(eventId: eventId, scanLinkToken: scanLinkToken)
            fresh.receivedAt = Date()
            setSnapshot(fresh)
            saveSnapshot()
            lastError = nil
        } catch APIError.httpError(403) {
            // Switched off on the server — the copy shouldn't outlive that.
            drop(eventId: eventId)
        } catch {
            // Offline or slow: keep using the copy we already have.
        }
    }

    // MARK: - Answering a scan

    static func hash(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// The verdict from the local copy, in the same shape /api/validate
    /// returns, plus a line for the screen saying it came from the copy.
    func answer(token: String, eventName: String?, scanLinkToken: String?) -> (ValidateResponse, String) {
        let h = Self.hash(token)
        guard var snap = snapshot, let i = index[h] else {
            return (ValidateResponse(status: "invalid", message: nil, name: nil, firstName: nil, lastName: nil, email: nil,
                                     used_at: nil, ticketId: nil, registrationId: nil, eventName: eventName, customFields: nil),
                    "Not in this device's offline copy. It may have been issued after the last sync.")
        }
        var t = snap.tickets[i]
        let now = ISO8601DateFormatter.withFractional.string(from: Date())
        let reentry = snap.allowReentry == true
        func response(_ status: String) -> ValidateResponse {
            ValidateResponse(status: status, message: nil, name: t.name, firstName: t.firstName, lastName: t.lastName,
                             email: nil, used_at: t.usedAt, ticketId: t.id, registrationId: t.registrationId,
                             eventName: eventName, customFields: t.customFields)
        }
        let checkedInNote = "Offline — checked against this device's copy. Will sync when back online."

        if t.usedAt == nil, t.expired == true {
            return (response("expired"), "Offline — this device's copy shows the ticket as expired.")
        }
        if t.usedAt != nil {
            if reentry, t.reentryStatus == "outside" {
                t.reentryStatus = "inside"
                snap.tickets[i] = t
                snapshot = snap
                saveSnapshot()
                enqueue(token: token, h: h, kind: "reentry_enter", at: now, eventId: snap.eventId, scanLinkToken: scanLinkToken)
                return (response("reentry_enter"), checkedInNote)
            }
            return (response("used"), reentry
                    ? "Offline — already inside. Checking out needs a connection."
                    : "Offline — this device's copy shows them already checked in.")
        }
        t.usedAt = now
        if reentry { t.reentryStatus = "inside" }
        snap.tickets[i] = t
        snapshot = snap
        saveSnapshot()
        enqueue(token: token, h: h, kind: "checkin", at: now, eventId: snap.eventId, scanLinkToken: scanLinkToken)
        return (response("valid"), checkedInNote)
    }

    private func enqueue(token: String, h: String, kind: String, at: String, eventId: String, scanLinkToken: String?) {
        queue.append(OfflineQueuedScan(id: UUID().uuidString, eventId: eventId, scanLinkToken: scanLinkToken,
                                       token: token, h: h, kind: kind, scannedAt: at))
        saveQueue()
    }

    /// Keeps the copy in step with what the server just said about a ticket.
    func noteOnlineResult(token: String, response: ValidateResponse) {
        guard var snap = snapshot, let i = index[Self.hash(token)] else { return }
        let now = ISO8601DateFormatter.withFractional.string(from: Date())
        switch response.status {
        case "valid":
            if snap.tickets[i].usedAt == nil { snap.tickets[i].usedAt = now }
            if snap.allowReentry == true { snap.tickets[i].reentryStatus = "inside" }
        case "reentry_enter":
            snap.tickets[i].reentryStatus = "inside"
        case "used":
            snap.tickets[i].usedAt = response.used_at ?? snap.tickets[i].usedAt ?? now
        case "expired":
            snap.tickets[i].expired = true
        default:
            return
        }
        snapshot = snap
        saveSnapshot()
    }

    func noteCheckout(token: String?, registrationId: String?) {
        guard var snap = snapshot else { return }
        let i: Int? = token.flatMap { index[Self.hash($0)] }
            ?? registrationId.flatMap { rid in snap.tickets.firstIndex { $0.registrationId == rid } }
        guard let i else { return }
        snap.tickets[i].reentryStatus = "outside"
        snapshot = snap
        saveSnapshot()
    }

    /// The server answered after the copy already had. If it checked them
    /// in, the queued offline scan is the same check-in and must not be
    /// replayed as someone else's double entry.
    func noteLateReply(token: String, status: String) {
        let kind: String
        switch status {
        case "valid": kind = "checkin"
        case "reentry_enter": kind = "reentry_enter"
        default: return
        }
        if let i = queue.firstIndex(where: { $0.token == token && $0.kind == kind }) {
            queue.remove(at: i)
            saveQueue()
        }
    }

    // MARK: - Sync

    func flush() async {
        guard !syncing, !queue.isEmpty else { return }
        syncing = true
        defer { syncing = false }
        let pairToken = UserDefaults.standard.string(forKey: "scannerPairToken")
        var synced = 0
        var doubles: [String] = []
        let groups = Dictionary(grouping: queue) { "\($0.eventId)|\($0.scanLinkToken ?? "")" }
        for items in groups.values {
            guard let first = items.first else { continue }
            let batch = Array(items.prefix(500))
            do {
                let res = try await APIService.shared.syncOfflineScans(eventId: first.eventId, scans: batch,
                                                                     pairToken: pairToken, scanLinkToken: first.scanLinkToken)
                let done = Set(res.results.map(\.id))
                for r in res.results where r.result == "already_used" {
                    if let q = batch.first(where: { $0.id == r.id }), let i = index[q.h], let snap = snapshot, snap.eventId == q.eventId {
                        doubles.append(snap.tickets[i].firstName ?? snap.tickets[i].name ?? "A guest")
                    } else {
                        doubles.append("A guest")
                    }
                }
                synced += done.count
                queue.removeAll { done.contains($0.id) }
                saveQueue()
            } catch APIError.httpError(let code) where code == 401 || code == 404 {
                // Lost access, or the event is gone — nothing this device
                // sends will land. Keep the scans, say so.
                lastError = "Some offline check-ins can't sync — this device no longer has access to that event."
            } catch {
                break // still offline; try again on the next tick
            }
        }
        if synced > 0 {
            var msg = "\(synced) check-in\(synced == 1 ? "" : "s") sent to the server."
            if !doubles.isEmpty {
                msg += " \(doubles.count) had already been used on another device: \(doubles.prefix(3).joined(separator: ", "))\(doubles.count > 3 ? "…" : "")."
            }
            syncReport = msg
        }
    }

    // MARK: - Status

    func statusText(eventId: String?, enabled: Bool, fallbackMs: Int?) -> String {
        var msg: String
        if let snap = snapshot, snap.eventId == eventId {
            let count = snap.tickets.count
            let fallback = String(format: "%.1f", Double(fallbackMs ?? 4000) / 1000)
            var ago = ""
            if let at = snap.receivedAt {
                let s = max(0, Int(Date().timeIntervalSince(at)))
                ago = s < 60 ? ", updated \(s)s ago" : s < 3600 ? ", updated \(s / 60) min ago" : ", updated \(s / 3600) h ago"
            }
            msg = "Offline copy ready: \(count) ticket\(count == 1 ? "" : "s")\(ago). If the server takes longer than \(fallback)s, scans are checked against it."
        } else if enabled {
            msg = "Offline backup is on, but this device hasn't downloaded a copy yet. It needs a connection once."
        } else {
            msg = "Offline backup is off for this event."
        }
        if !queue.isEmpty {
            msg += " \(queue.count) offline check-in\(queue.count == 1 ? " is" : "s are") waiting to sync."
        }
        if let lastError { msg += " " + lastError }
        return msg
    }
}

extension ISO8601DateFormatter {
    /// Matches the server's `new Date().toISOString()` — milliseconds included.
    static let withFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}
