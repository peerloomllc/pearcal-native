import ExpoModulesCore
import Network

// Forces the iOS Local Network permission prompt.
//
// iOS only surfaces the Local Network prompt (and the per-app toggle under
// Settings) the first time an app actually touches the LAN: Bonjour, multicast,
// or a direct connection to a same-subnet address. PearCal's transport is
// Hyperswarm/hyperdht running inside the Bare worklet, which reaches peers via
// the DHT + UDP holepunch and, on first launch, may never attempt a direct
// same-subnet connection - so the prompt never fires and same-WiFi peers fall
// back to the slower relayed path. This module nudges the OS by advertising and
// browsing a throwaway Bonjour service (`_pearcallan._tcp`, declared in
// NSBonjourServices), which makes iOS evaluate LAN access and present the
// prompt. Once the user grants it, the whole app process (including the Bare
// sockets) is allowed to reach LAN peers directly.
public class LocalNetworkModule: Module {
  private var listener: NWListener?
  private var browser: NWBrowser?
  private let queue = DispatchQueue(label: "com.pearcal.localnetwork")
  private let serviceType = "_pearcallan._tcp"

  public func definition() -> ModuleDefinition {
    Name("LocalNetwork")

    // Fire-and-forget: start the probe and resolve immediately. The prompt is
    // presented by the OS as soon as browsing begins; we do not (and cannot
    // reliably) detect the user's grant/deny decision here.
    AsyncFunction("requestPermission") { [weak self] (promise: Promise) in
      self?.startProbe()
      promise.resolve(true)
    }

    OnDestroy { [weak self] in
      self?.stopProbe()
    }
  }

  private func startProbe() {
    queue.async { [weak self] in
      guard let self else { return }
      self.stopProbe()

      // Advertise so the browser below has a service to find; the pairing of
      // advertise + browse is what Apple's own Local Network sample uses.
      if let listener = try? NWListener(using: .tcp) {
        listener.service = NWListener.Service(name: "PearCal", type: self.serviceType)
        listener.newConnectionHandler = { $0.cancel() }
        listener.start(queue: self.queue)
        self.listener = listener
      }

      // Browsing is the action that makes iOS evaluate LAN access and show the
      // prompt. includePeerToPeer covers the AWDL/peer-to-peer case too.
      let params = NWParameters()
      params.includePeerToPeer = true
      let browser = NWBrowser(for: .bonjour(type: self.serviceType, domain: nil), using: params)
      browser.start(queue: self.queue)
      self.browser = browser

      // We only needed to trigger the grant, not to keep discovering. Tear the
      // probe down after the prompt has had time to appear.
      self.queue.asyncAfter(deadline: .now() + 8.0) { [weak self] in
        self?.stopProbe()
      }
    }
  }

  private func stopProbe() {
    browser?.cancel()
    browser = nil
    listener?.cancel()
    listener = nil
  }
}
