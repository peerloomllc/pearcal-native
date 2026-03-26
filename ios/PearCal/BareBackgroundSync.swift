import BackgroundTasks

@objc(PearCalBGSync)
class BareBackgroundSync: NSObject {
  static let taskIdentifier = "com.pearcal.bgsync"
  // Lock guards all access to pendingTask and expirationTimer (accessed from BGTask callback + JS thread)
  private static let lock = NSLock()
  private static var pendingTask: BGAppRefreshTask?
  private static var expirationTimer: Timer?

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
    scheduleNext()
  }

  static func scheduleNext() {
    let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
    request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
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
