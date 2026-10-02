//
//  DashboardWebView.swift
//  Ticket Check In
//

import SwiftUI
import WebKit

/// Wraps the web dashboard in-app, authenticated with the same session
/// cookie APIService's URLSession.shared already holds — WKWebView has its
/// own separate cookie jar by default, so we copy the cookie over before
/// the first load.
struct DashboardWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        WKWebView()
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard !context.coordinator.hasLoaded else { return }
        context.coordinator.hasLoaded = true
        syncCookies(into: webView) {
            webView.load(URLRequest(url: url))
        }
    }

    private func syncCookies(into webView: WKWebView, completion: @escaping () -> Void) {
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        guard !cookies.isEmpty else { completion(); return }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for cookie in cookies {
            group.enter()
            store.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main, execute: completion)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    class Coordinator {
        var hasLoaded = false
    }
}

/// Sheet presenting the logged-in web dashboard — the "Manage on the web"
/// escape hatch from both the event picker and Settings. Opens straight to the
/// event the app has selected (dashboard.html?event=<id>), using the same
/// precedence as ScannerView: an active scan link's event, else the signed-in
/// user's own selected event. With nothing selected it opens the event list.
struct DashboardWebSheet: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage("lastSelectedEventData") private var lastSelectedEventData: Data = Data()
    @AppStorage("scanLinkEventData") private var scanLinkEventData: Data = Data()

    private var selectedEventId: String? {
        if !scanLinkEventData.isEmpty,
           let link = try? JSONDecoder().decode(ScannerLinkInfo.self, from: scanLinkEventData) {
            return link.eventId
        }
        if !lastSelectedEventData.isEmpty,
           let event = try? JSONDecoder().decode(Event.self, from: lastSelectedEventData) {
            return event.id
        }
        return nil
    }

    private var url: URL {
        var components = URLComponents(string: "\(baseURL)/dashboard.html")!
        if let id = selectedEventId, !id.isEmpty {
            components.queryItems = [URLQueryItem(name: "event", value: id)]
        }
        return components.url!
    }

    var body: some View {
        if #available(iOS 16, *) {
            NavigationStack { content }
        } else {
            NavigationView { content }
        }
    }

    @ViewBuilder
    private var content: some View {
        DashboardWebView(url: url)
            .navigationTitle("Dashboard")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
    }
}
