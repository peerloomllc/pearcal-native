import BackgroundTasks
import Expo
import React
import ReactAppDependencyProvider
import UserNotifications

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory
    bindReactNativeFactory(factory)

    // The window is made by SceneDelegate, below.

    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: BareBackgroundSync.refreshIdentifier,
      using: nil
    ) { task in
      BareBackgroundSync.handleBGTask(task as! BGAppRefreshTask)
    }
    BGTaskScheduler.shared.register(
      forTaskWithIdentifier: BareBackgroundSync.processingIdentifier,
      using: nil
    ) { task in
      BareBackgroundSync.handleProcessingTask(task as! BGProcessingTask)
    }
    BareBackgroundSync.scheduleNextRefresh()
    BareBackgroundSync.scheduleNextProcessing()
    UNUserNotificationCenter.current().delegate = self

    // An invite link that COLD-LAUNCHES the app never reaches
    // application(_:open:options:) below — iOS delivers it here in launchOptions
    // instead, and calls that method only when the app was already running. With
    // nothing reading launchOptions the URL was simply dropped, so tapping an
    // invite opened PearCal to a normal calendar and nothing else happened.
    //
    // Scope, measured on an iPhone SE 2026-08-07 rather than assumed. This
    // affects the LEGACY `pearcal://` shape only, and is a robustness fix rather
    // than the urgent one an earlier version of this comment claimed:
    //
    //   https://peerloomllc.com/join?…   warm: works    cold: works
    //   pearcal://join?…                 warm: works    cold: WAS DROPPED (this)
    //
    // The share sheet emits the https form, so the link real users receive was
    // never affected. `pearcal://` survives only for older links already in
    // circulation. Android is unaffected either way — its LinkModule is fed by
    // an intent filter that fires in both states.
    //
    // Since the app adopted UIScene for iOS 27 (2026-09-28), a cold-launch URL no
    // longer reaches launchOptions here. SceneDelegate, at the bottom of this file,
    // passes it to application(_:open:options:) below instead, which sets the same
    // pendingLink. The JS side never consults Linking.getInitialURL(), it only
    // polls PearCalLink.getPendingLink().
    //
    // Universal links are NOT handled here on purpose. For those iOS still calls
    // application(_:continue:) after a cold launch, so the existing handler
    // already covers them.
    if let url = launchOptions?[.url] as? URL, url.scheme == "pearcal" {
      LinkModule.pendingLink = url.absoluteString
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if url.scheme == "pearcal" {
      LinkModule.pendingLink = url.absoluteString
    }
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
       let url = userActivity.webpageURL,
       url.host == "peerloomllc.com",
       url.path.hasPrefix("/join") {
      LinkModule.pendingLink = url.absoluteString
      return true  // Handled — don't let Expo Router navigate to /join
    }
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }

}

extension AppDelegate: UNUserNotificationCenterDelegate {
  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let info = response.notification.request.content.userInfo
    if let tab = info["tab"] as? String, !tab.isEmpty {
      LinkModule.pendingTab = tab
    }
    if let gsid = info["groupSettingsId"] as? String, !gsid.isEmpty {
      LinkModule.pendingGroupSettingsId = gsid
    }
    completionHandler()
  }

  public func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}

// with-ios-scene-lifecycle
class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }
    let window = UIWindow(windowScene: windowScene)
    self.window = window
    appDelegate.window = window

    var launchOptions: [UIApplication.LaunchOptionsKey: Any] = [:]
    if let url = connectionOptions.urlContexts.first?.url {
      launchOptions[.url] = url
    }
    factory.startReactNative(withModuleName: "main", in: window, launchOptions: launchOptions)

    for context in connectionOptions.urlContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
    for activity in connectionOptions.userActivities {
      _ = appDelegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts {
      _ = appDelegate.application(UIApplication.shared, open: context.url, options: [:])
    }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let appDelegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = appDelegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }
}
