import Capacitor
import UIKit

/// Hosts the Capacitor web UI.
///
/// Capacitor's template is app-delegate/window based, but CarPlay needs a scene
/// manifest with UIApplicationSupportsMultipleScenes, and declaring any scene
/// configuration opts the whole app into the scene lifecycle - at which point
/// UIMainStoryboardFile is ignored and nothing builds the phone window. So the
/// window is constructed here, and UIMainStoryboardFile is removed from
/// Info.plist so there is exactly one path that creates it.
@objc(SJSceneDelegate)
class SJSceneDelegate: UIResponder, UIWindowSceneDelegate {

    var window: UIWindow?

    func scene(_ scene: UIScene,
               willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        // Built directly rather than from Main.storyboard: with the storyboard
        // in play the scene had two competing owners and neither won.
        window.rootViewController = SJBridgeViewController()
        window.backgroundColor = UIColor(red: 0.04, green: 0.04, blue: 0.04, alpha: 1)
        self.window = window
        window.makeKeyAndVisible()
    }
}
