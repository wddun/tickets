//
//  RoomChatView.swift
//  Ticket Check In
//
//  One shared chat thread for every scanner (web or iOS) working an event
//  plus whoever has the monitor open — see roomMessages in db-sqlite.js.
//  Distinct from the 1:1 admin<->scanner DM (NotificationBanner's reply
//  field): this is a room, not a private line to the organiser.
//

import SwiftUI
import Combine

/// Bridges the live SSE stream ScannerView already holds open to this sheet,
/// which is presented/dismissed independently and shouldn't need its own
/// second connection just to receive messages sent by other scanners.
@MainActor
final class RoomChatStore: ObservableObject {
    static let shared = RoomChatStore()
    @Published var messages: [RoomChatMessage] = []
    @Published var unreadCount = 0
    private(set) var eventId: String?
    var isOpen = false

    private init() {}

    /// Called whenever the scanner locks onto a (possibly different) event —
    /// a message thread for the old event has no business surviving a switch.
    func reset(for eventId: String?) {
        guard eventId != self.eventId else { return }
        self.eventId = eventId
        messages = []
        unreadCount = 0
    }

    func setLoaded(_ loaded: [RoomChatMessage]) {
        messages = loaded
    }

    func ingest(_ msg: RoomChatMessage, mySenderPairToken: String) {
        guard msg.eventId == eventId else { return }
        messages.append(msg)
        if messages.count > 200 { messages.removeFirst(messages.count - 200) }
        if !isOpen && msg.pairToken != mySenderPairToken {
            unreadCount += 1
        }
    }
}

struct RoomChatView: View {
    let pairToken: String
    let eventName: String

    @ObservedObject private var store = RoomChatStore.shared
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var isLoading = true
    @State private var isSending = false
    @State private var loadError: String?
    @FocusState private var inputFocused: Bool

    var body: some View {
        NavigationView {
            VStack(spacing: 0) {
                if isLoading {
                    Spacer()
                    ProgressView()
                    Spacer()
                } else if let loadError, store.messages.isEmpty {
                    Spacer()
                    VStack(spacing: 8) {
                        Text(loadError).foregroundStyle(.secondary).font(.subheadline)
                        Button("Retry") { Task { await load() } }
                    }
                    Spacer()
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 10) {
                                if store.messages.isEmpty {
                                    Text("No messages yet — say hi to whoever else is working the door.")
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, 40)
                                }
                                ForEach(store.messages) { m in
                                    RoomChatBubble(message: m, isMine: m.pairToken == pairToken)
                                        .id(m.id)
                                }
                            }
                            .padding(14)
                        }
                        .onChange(of: store.messages.count) { _ in
                            if let last = store.messages.last {
                                withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                            }
                        }
                        .onAppear {
                            if let last = store.messages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                }

                Divider()
                HStack(spacing: 10) {
                    TextField("Message the room…", text: $draft)
                        .textFieldStyle(.roundedBorder)
                        .focused($inputFocused)
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.system(size: 30))
                    }
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSending)
                }
                .padding(12)
            }
            .navigationTitle("Room Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Text(eventName).font(.caption).foregroundStyle(.secondary)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onAppear {
            store.isOpen = true
            store.unreadCount = 0
            Task { await load() }
        }
        .onDisappear {
            store.isOpen = false
        }
    }

    private func load() async {
        isLoading = store.messages.isEmpty
        loadError = nil
        do {
            let messages = try await APIService.shared.fetchRoomMessages(pairToken: pairToken)
            store.setLoaded(messages)
        } catch {
            loadError = "Couldn't load messages."
        }
        isLoading = false
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        isSending = true
        Task {
            // Arrives back over the SSE stream (room_chat) and renders from
            // there, same as the monitor's own send — one source of order.
            try? await APIService.shared.sendRoomMessage(pairToken: pairToken, text: text)
            isSending = false
        }
    }
}

private struct RoomChatBubble: View {
    let message: RoomChatMessage
    let isMine: Bool

    private var timeLabel: String {
        guard let date = ISO8601DateFormatter().date(from: message.createdAt) else { return "" }
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }

    var body: some View {
        VStack(alignment: isMine ? .trailing : .leading, spacing: 3) {
            Text(message.senderName)
                .font(.caption2.weight(.bold))
                .foregroundStyle(message.senderType == "monitor" ? .blue : .secondary)
            Text(message.text)
                .font(.subheadline)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isMine ? Color.accentColor : Color(.secondarySystemBackground))
                .foregroundStyle(isMine ? .white : .primary)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            if !timeLabel.isEmpty {
                Text(timeLabel).font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: 280, alignment: isMine ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
    }
}
