import AuthenticationServices
import Capacitor
import UIKit

/// Google sign-in for the shell.
///
/// Google refuses OAuth inside an embedded web view (disallowed_useragent), so
/// this can never happen in the page itself. Navigating there instead handed
/// the whole flow to Safari and dropped the listener out of the app.
///
/// ASWebAuthenticationSession is the sanctioned middle ground: a sheet that
/// slides over the app, backed by real Safari (so an existing Google session
/// carries over), and it hands the callback URL straight back rather than
/// relying on a deep link round trip.
@objc(SJAuth)
public class SJAuth: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding {

    public let identifier = "SJAuth"
    public let jsName = "SJAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise)
    ]

    /// Held for the life of the flow - a released session closes the sheet.
    private var session: ASWebAuthenticationSession?

    @objc func signIn(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let scheme = call.getString("callbackScheme") else {
            call.reject("url and callbackScheme are required")
            return
        }

        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: scheme
            ) { [weak self] callbackURL, error in
                defer { self?.session = nil }

                if let error = error as NSError? {
                    // Dismissing the sheet is a normal outcome, not a failure.
                    if error.domain == ASWebAuthenticationSessionError.errorDomain,
                       error.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        call.reject("Sign-in cancelled", "cancelled")
                        return
                    }
                    call.reject(error.localizedDescription)
                    return
                }
                guard let callbackURL else {
                    call.reject("Sign-in finished without a callback URL")
                    return
                }
                call.resolve(["url": callbackURL.absoluteString])
            }

            session.presentationContextProvider = self
            // Deliberately not ephemeral: reusing the Safari session is what
            // makes this one tap for someone already signed in to Google.
            session.prefersEphemeralWebBrowserSession = false
            self.session = session

            if !session.start() {
                self.session = nil
                call.reject("Could not start the sign-in session")
            }
        }
    }

    /// Called on the main thread by ASWebAuthenticationSession, so this must not
    /// hop queues: a DispatchQueue.main.sync here deadlocks against the thread
    /// it is already on and the runtime traps immediately (EXC_BREAKPOINT), which
    /// looks exactly like the app quitting the moment you tap Sign In.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
