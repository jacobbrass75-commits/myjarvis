import SwiftUI
import WebKit

@main
struct JarvisG2App: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .environmentObject(model.settings)
                .environmentObject(model.glasses)
                .environmentObject(model.host.mirror)
                .environmentObject(AppLog.shared)
                .onAppear { model.boot() }
        }
    }
}

/// Wires the pieces together: settings, the BLE link, and the WKWebView running the glasses web app
/// with our Even Hub host injected.
@MainActor
final class AppModel: NSObject, ObservableObject, WKNavigationDelegate {
    let settings = AppSettings()
    let glasses: GlassesLink
    let host: EvenHubHost
    let webView: WKWebView
    @Published var pageStatus = "not loaded"
    private var booted = false

    override init() {
        glasses = GlassesLink(settings: settings)
        host = EvenHubHost(settings: settings, glasses: glasses)
        let config = WKWebViewConfiguration()
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: EvenHubHost.userScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        ucc.addScriptMessageHandler(host, contentWorld: .page, name: EvenHubHost.handlerName)
        ucc.add(host, name: EvenHubHost.logHandlerName)
        config.userContentController = ucc
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true // Safari > Develop > (device) to debug the page
        webView.backgroundColor = .black
        webView.isOpaque = false
        super.init()
        host.webView = webView
        webView.navigationDelegate = self
    }

    func boot() {
        guard !booted else { return }
        booted = true
        log("Jarvis G2 starting\(GlassesLink.isSimulator ? " in the iOS Simulator (no Bluetooth LE)" : "")")
        glasses.start()
        loadPage()
    }

    func loadPage() {
        guard let url = settings.glassesPageURL else {
            pageStatus = "set the hub URL in Settings"
            return
        }
        host.pageWillLoad()
        pageStatus = "loading \(url.absoluteString)"
        log("loading \(url.absoluteString)")
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated {
            pageStatus = "loaded \(webView.url?.absoluteString ?? "")"
            log("page loaded")
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated {
            pageStatus = "could not load the page: \(error.localizedDescription)"
            log(pageStatus)
        }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated {
            pageStatus = "page error: \(error.localizedDescription)"
            log(pageStatus)
        }
    }
}
