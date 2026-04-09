import BackgroundTasks

@objc(PearCalBGSync)
class BareBackgroundSync: NSObject {
  static let refreshIdentifier = "com.pearcal.bgsync"
  static let processingIdentifier = "com.pearcal.bgprocessing"
  // Lock guards all access to pendingTask and expirationTimer (accessed from BGTask callback + JS thread)
  private static let lock = NSLock()
  private static var pendingTask: BGTask?
  private static var expirationTimer: Timer?

  // --- BGAppRefreshTask (short ~25s sync, fires every ~15 min) ---
  static func handleBGTask(_ task: BGAppRefreshTask) {
    lock.lock()
    pendingTask = task
    lock.unlock()
    // Schedule on main runloop so Timer fires even if no RN JS loop is running yet
    DispatchQueue.main.async {
      let timer = Timer.scheduledTimer(withTimeInterval: 25, repeats: false) { _ in
        lock.lock()
        pendingTask?.setTaskCompleted(success: false)
        pendingTask = nil
        expirationTimer = nil
        lock.unlock()
      }
      lock.lock()
      expirationTimer = timer
      lock.unlock()
    }
    task.expirationHandler = {
      lock.lock()
      expirationTimer?.invalidate()
      expirationTimer = nil
      pendingTask?.setTaskCompleted(success: false)
      pendingTask = nil
      lock.unlock()
    }
    scheduleNextRefresh()
  }

  // --- BGProcessingTask (long sync, runs when charging + WiFi) ---
  static func handleProcessingTask(_ task: BGProcessingTask) {
    lock.lock()
    pendingTask = task
    lock.unlock()
    // Allow up to 120s for full Hyperswarm reconnect + replication
    DispatchQueue.main.async {
      let timer = Timer.scheduledTimer(withTimeInterval: 120, repeats: false) { _ in
        lock.lock()
        pendingTask?.setTaskCompleted(success: false)
        pendingTask = nil
        expirationTimer = nil
        lock.unlock()
      }
      lock.lock()
      expirationTimer = timer
      lock.unlock()
    }
    task.expirationHandler = {
      lock.lock()
      expirationTimer?.invalidate()
      expirationTimer = nil
      pendingTask?.setTaskCompleted(success: false)
      pendingTask = nil
      lock.unlock()
    }
    scheduleNextProcessing()
  }

  static func scheduleNextRefresh() {
    let request = BGAppRefreshTaskRequest(identifier: refreshIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
    try? BGTaskScheduler.shared.submit(request)
  }

  static func scheduleNextProcessing() {
    let request = BGProcessingTaskRequest(identifier: processingIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60) // every ~1 hour
    request.requiresNetworkConnectivity = true
    try? BGTaskScheduler.shared.submit(request)
  }

  @objc func checkPendingBGSync(
    _ resolve: RCTPromiseResolveBlock,
    reject: RCTPromiseRejectBlock
  ) {
    BareBackgroundSync.lock.lock()
    let hasPending = BareBackgroundSync.pendingTask != nil
    BareBackgroundSync.lock.unlock()
    resolve(hasPending)
  }

  // Called from JS when sync completes. No-op if no BGTask is pending (e.g. sync triggered by foreground action).
  @objc func completeBGSync(_ success: NSNumber) {
    BareBackgroundSync.lock.lock()
    BareBackgroundSync.expirationTimer?.invalidate()
    BareBackgroundSync.expirationTimer = nil
    BareBackgroundSync.pendingTask?.setTaskCompleted(success: success.boolValue)
    BareBackgroundSync.pendingTask = nil
    BareBackgroundSync.lock.unlock()
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
