//
//  AtDoorView.swift
//  Ticket Check In
//
//  In-app "At Door" tab. Free events: staff fills in a quick form and the
//  ticket is emailed. Paid events: shows a QR code linking to the public
//  registration page so the customer pays on their own phone via the
//  existing Stripe Checkout flow.
//

import SwiftUI
import CoreImage.CIFilterBuiltins
import UIKit

struct AtDoorView: View {
    let event: Event

    @State private var name = ""
    @State private var email = ""
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @State private var successName: String?
    @State private var showShareSheet = false

    private var isPaid: Bool { (event.ticketPrice ?? 0) > 0 }
    private var priceLabel: String {
        let cents = event.ticketPrice ?? 0
        return String(format: "$%.2f", Double(cents) / 100.0)
    }
    private var registrationURL: String {
        "\(baseURL)/register.html?id=\(event.id)"
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                header

                if isPaid {
                    paidQRBlock
                } else if let success = successName {
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
            }
            .padding()
        }
        .navigationTitle("At Door")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var header: some View {
        VStack(spacing: 4) {
            Text(event.name).font(.headline)
            if isPaid {
                Text("Paid event  •  \(priceLabel)")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("Free event  •  no card needed")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
    }

    // MARK: - Paid: QR code

    private var paidQRBlock: some View {
        VStack(spacing: 14) {
            if let img = QRCode.image(from: registrationURL) {
                Image(uiImage: img)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: 280)
                    .padding(12)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
                    .shadow(color: .black.opacity(0.08), radius: 8, y: 2)
            } else {
                Text("Failed to generate QR")
                    .foregroundStyle(.red)
            }

            VStack(spacing: 4) {
                Text("Customer scans to buy")
                    .font(.headline)
                Text("They'll pay \(priceLabel) on their own phone via Stripe.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            HStack(spacing: 10) {
                Button {
                    UIPasteboard.general.string = registrationURL
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.accentColor.opacity(0.15))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                Button {
                    showShareSheet = true
                } label: {
                    Label("Share", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Color.accentColor.opacity(0.15))
                        .foregroundStyle(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .sheet(isPresented: $showShareSheet) {
                    ShareSheet(items: [URL(string: registrationURL) ?? registrationURL as Any])
                }
            }

            Text(registrationURL)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .textSelection(.enabled)
                .padding(.top, 4)
        }
    }

    // MARK: - Free: form

    private var inputCard: some View {
        VStack(spacing: 12) {
            TextField("Attendee name", text: $name)
                .textContentType(.name)
                .textInputAutocapitalization(.words)
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))

            TextField("Email (optional)", text: $email)
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
                Text("Issue Free Ticket").fontWeight(.semibold)
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
            Text("Ticket issued").font(.title3.weight(.semibold))
            Text(buyerName).font(.headline)
            if !email.isEmpty {
                Text("Sent to \(email)")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Button {
                resetForNext()
            } label: {
                Text("Register another")
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

    // MARK: - Actions

    private func submit() {
        errorMessage = nil
        isSubmitting = true
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let e = email.trimmingCharacters(in: .whitespacesAndNewlines)

        Task {
            do {
                let resp = try await APIService.shared.registerAtDoor(
                    eventId: event.id, name: n, email: e.isEmpty ? nil : e
                )
                successName = resp.name ?? n
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
    }
}

// MARK: - Share sheet wrapper (iOS 15-compatible)

private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - QR helper

private enum QRCode {
    static func image(from string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let transform = CGAffineTransform(scaleX: 10, y: 10)
        let scaled = output.transformed(by: transform)
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
