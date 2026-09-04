import Capacitor
import UIKit

/// Capacitor auto-registers plugins that ship as npm packages. SJNativeAudio
/// lives in the app target instead, so it has to be handed to the bridge
/// explicitly - without this the web layer sees no plugin at all.
@objc(SJBridgeViewController)
class SJBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(SJNativeAudio())
    }
}
