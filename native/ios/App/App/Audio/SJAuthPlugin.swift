import AuthenticationServices
import Capacitor
import CryptoKit
import UIKit

/// Google and Apple sign-in for the shell.
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
public class SJAuth: CAPPlugin, CAPBridgedPlugin,
    ASWebAuthenticationPresentationContextProviding,
    ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {

    public let identifier = "SJAuth"
    public let jsName = "SJAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "signIn", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "signInWithApple", returnType: CAPPluginReturnPromise)
    ]

    /// Held for the life of the flow - a released session closes the sheet.
    private var session: ASWebAuthenticationSession?
    private var appleController: ASAuthorizationController?
    private var appleCall: CAPPluginCall?
    private var appleRawNonce: String?

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

    /// Native Sign in with Apple. The raw nonce comes back to the web layer so
    /// Supabase can verify the identity token without a client secret or a
    /// browser redirect. That keeps Listening Party independent of the
    /// ShutterField web Services ID on the shared Supabase project.
    @objc func signInWithApple(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard self.appleCall == nil else {
                call.reject("Another Apple sign-in is already in progress")
                return
            }

            do {
                let rawNonce = try Self.randomNonce()
                let request = ASAuthorizationAppleIDProvider().createRequest()
                request.requestedScopes = [.fullName, .email]
                request.nonce = Self.sha256(rawNonce)

                let controller = ASAuthorizationController(authorizationRequests: [request])
                controller.delegate = self
                controller.presentationContextProvider = self
                self.appleCall = call
                self.appleRawNonce = rawNonce
                self.appleController = controller
                controller.performRequests()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let call = appleCall,
              let rawNonce = appleRawNonce,
              let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            finishAppleSignIn(rejecting: "Apple returned an invalid identity token")
            return
        }

        var result: [String: Any] = [
            "identityToken": token,
            "nonce": rawNonce,
            "user": credential.user
        ]
        if let email = credential.email { result["email"] = email }
        if let fullName = credential.fullName {
            let rendered = PersonNameComponentsFormatter.localizedString(
                from: fullName,
                style: .default,
                options: []
            ).trimmingCharacters(in: .whitespacesAndNewlines)
            if !rendered.isEmpty { result["fullName"] = rendered }
        }

        clearAppleSignIn()
        call.resolve(result)
    }

    public func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        let nsError = error as NSError
        if nsError.domain == ASAuthorizationError.errorDomain,
           nsError.code == ASAuthorizationError.canceled.rawValue {
            finishAppleSignIn(rejecting: "Sign-in cancelled", code: "cancelled")
        } else {
            finishAppleSignIn(rejecting: error.localizedDescription)
        }
    }

    private func finishAppleSignIn(rejecting message: String, code: String? = nil) {
        let call = appleCall
        clearAppleSignIn()
        call?.reject(message, code)
    }

    private func clearAppleSignIn() {
        appleCall = nil
        appleRawNonce = nil
        appleController = nil
    }

    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func randomNonce(length: Int = 32) throws -> String {
        precondition(length > 0)
        let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var result = ""
        var bytes = [UInt8](repeating: 0, count: 16)

        while result.count < length {
            let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            guard status == errSecSuccess else {
                throw NSError(
                    domain: "SJAuth",
                    code: Int(status),
                    userInfo: [NSLocalizedDescriptionKey: "Could not create a secure sign-in nonce"]
                )
            }
            for byte in bytes where byte < alphabet.count {
                result.append(alphabet[Int(byte)])
                if result.count == length { break }
            }
        }
        return result
    }

    /// Called on the main thread by ASWebAuthenticationSession, so this must not
    /// hop queues: a DispatchQueue.main.sync here deadlocks against the thread
    /// it is already on and the runtime traps immediately (EXC_BREAKPOINT), which
    /// looks exactly like the app quitting the moment you tap Sign In.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.viewController?.view.window ?? ASPresentationAnchor()
    }
}
