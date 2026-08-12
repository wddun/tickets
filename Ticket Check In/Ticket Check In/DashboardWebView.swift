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
/// escape hatch from both the event picker and Settings.
struct DashboardWebSheet: View {
    @Environment(\.dismiss) private var dismiss
    private let url = URL(string: "\(baseURL)/dashboard.html")!

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
