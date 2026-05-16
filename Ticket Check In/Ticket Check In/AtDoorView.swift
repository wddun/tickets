//
//  AtDoorView.swift
//  Ticket Check In
//
//  In-app "At Door" tab — collects buyer info, runs Tap to Pay on iPhone
//  (paid events) or issues a free ticket (free events), then resets for the next.
//

import SwiftUI

struct AtDoorView: View {
    let event: Event

    @StateObject private var terminal = TerminalService.shared
    @State private var name = ""
    @State private var email = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var successName: String?

    private var isPaid: Bool { (event.ticketPrice ?? 0) > 0 }
    private var priceLabel: String {
        let cents = event.ticketPrice ?? 0
        let dollars = Double(cents) / 100.0
        return String(format: "$%.2f", dollars)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header

                if let success = successName {
                    successCard(success)
                } else {
                    inputCard
                    submitButton
                }

                if let err = errorMessage {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)
                }

                statusBlock
            }
            .padding()
        }
        .navigationTitle("At Door")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text(event.name)
                .font(.headline)
            if isPaid {
                Text("Tap-to-pay sale  •  \(priceLabel)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                Text("Free ticket  •  no card needed")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    private var inputCard: some View {
        VStack(spacing: 12) {
            TextField("Buyer name", text: $name)
                .textContentType(.name)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))

            TextField("Email (optional but recommended)", text: $email)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private var submitButton: some View {
        Button(action: submit) {
            HStack {
                if isSubmitting { ProgressView().tint(.white) }
                Text(isPaid ? "Tap to Pay  \(priceLabel)" : "Issue Free Ticket")
                    .fontWeight(.semibold)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(name.trimmingCharacters(in: .whitespaces).isEmpty ? Color.gray : Color.accentColor)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .disabled(isSubmitting || name.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    private func successCard(_ buyerName: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 48))
                .foregroundStyle(.green)
            Text("Ticket issued")
                .font(.title3.weight(.semibold))
            Text(buyerName)
                .font(.headline)
            if !email.isEmpty {
                Text("Confirmation sent to \(email)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button {
                resetForNext()
            } label: {
                Text("Sell another ticket")
                    .fontWeight(.semibold)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.accentColor.opacity(0.15))
                    .foregroundStyle(Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .padding(.top, 6)
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 14))
    }

    private var statusBlock: some View {
        Group {
            switch terminal.status {
            case .idle, .ready:
                EmptyView()
            case .initializing:
                statusLine("Initializing Tap to Pay…")
            case .discoveringReader:
                statusLine("Preparing the iPhone reader…")
            case .connectingReader:
                statusLine("Connecting to reader…")
            case .creatingPayment:
                statusLine("Setting up the charge…")
            case .waitingForTap:
                statusLine("Hold the card near the top of the iPhone")
            case .processingPayment:
                statusLine("Processing payment…")
            case .success:
                EmptyView()
            case .failed(let msg):
                statusLine(msg, isError: true)
            }
        }
    }

    private func statusLine(_ msg: String, isError: Bool = false) -> some View {
        HStack(spacing: 8) {
            if !isError { ProgressView() }
            Text(msg)
                .font(.subheadline)
                .foregroundStyle(isError ? .red : .secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    // MARK: - Actions

    private func submit() {
        errorMessage = nil
        isSubmitting = true
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let e = email.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            do {
                if isPaid {
                    let buyer = try await TerminalService.shared.chargeAndIssueTicket(
                        eventId: event.id, name: n, email: e.isEmpty ? nil : e
                    )
                    successName = buyer
                } else {
                    let resp = try await APIService.shared.issueFreeAtDoor(
                        eventId: event.id, name: n, email: e.isEmpty ? nil : e
                    )
                    successName = resp.name ?? n
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isSubmitting = false
        }
    }

    private func resetForNext() {
        name = ""
        email = ""
        successName = nil
        errorMessage = nil
        terminal.reset()
    }
}
