//
//  LogoView.swift
//  Ticket Check In
//

import SwiftUI

/// The app logo — a ticket with a checkmark — rendered as a SwiftUI view.
struct LogoView: View {
    var size: CGFloat = 80

    var body: some View {
        ZStack {
            // Background tile
            RoundedRectangle(cornerRadius: size * 0.22)
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "0e1234"), Color(hex: "1c2260")],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .frame(width: size, height: size)

            // Ticket body (white card)
            RoundedRectangle(cornerRadius: size * 0.06)
                .fill(Color.white.opacity(0.96))
                .frame(width: size * 0.72, height: size * 0.44)

            // Notch cut-outs using background circles
            let notch = size * 0.067
            Circle()
                .fill(LinearGradient(colors: [Color(hex: "0e1234"), Color(hex: "1c2260")],
                                     startPoint: .top, endPoint: .bottom))
                .frame(width: notch * 2, height: notch * 2)
                .offset(x: -size * 0.36)
            Circle()
                .fill(LinearGradient(colors: [Color(hex: "0e1234"), Color(hex: "1c2260")],
                                     startPoint: .top, endPoint: .bottom))
                .frame(width: notch * 2, height: notch * 2)
                .offset(x: size * 0.36)

            // Dashed perforation
            VStack(spacing: size * 0.025) {
                ForEach(0..<5, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color(hex: "c8cae0"))
                        .frame(width: size * 0.012, height: size * 0.04)
                }
            }
            .offset(x: -size * 0.025)

            // Checkmark
            CheckmarkShape()
                .stroke(
                    Color(hex: "34c759"),
                    style: StrokeStyle(lineWidth: size * 0.055, lineCap: .round, lineJoin: .round)
                )
                .frame(width: size * 0.28, height: size * 0.20)
                .offset(x: size * 0.06, y: size * 0.01)
        }
    }
}

struct CheckmarkShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 0, y: rect.height * 0.52))
        p.addLine(to: CGPoint(x: rect.width * 0.36, y: rect.height))
        p.addLine(to: CGPoint(x: rect.width, y: 0))
        return p
    }
}

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r = Double((int >> 16) & 0xff) / 255
        let g = Double((int >> 8) & 0xff) / 255
        let b = Double(int & 0xff) / 255
        self.init(red: r, green: g, blue: b)
    }
}
