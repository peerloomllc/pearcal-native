import UIKit
import AVFoundation

@objc(PearCalQRScanner)
class QRScannerModule: NSObject {

  private var scanResolve: RCTPromiseResolveBlock?
  private var scanReject: RCTPromiseRejectBlock?

  @objc func scan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    scanResolve = resolve
    scanReject = reject
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let vc = QRScannerViewController()
      vc.onResult = { [weak self] result in
        if let result = result {
          self?.scanResolve?(result)
        } else {
          self?.scanReject?("CANCELLED", "Scan cancelled", nil)
        }
        self?.scanResolve = nil
        self?.scanReject = nil
      }
      vc.modalPresentationStyle = .fullScreen
      guard let root = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first?.windows.first?.rootViewController else { return }
      var presenter = root
      while let presented = presenter.presentedViewController { presenter = presented }
      presenter.present(vc, animated: true)
    }
  }

  @objc static func requiresMainQueueSetup() -> Bool { return true }
}

class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
  var onResult: ((String?) -> Void)?
  private var session: AVCaptureSession?
  // Dedicated serial queue required by AVFoundation — start/stop must be called on the same queue
  private let sessionQueue = DispatchQueue(label: "com.pearcal.qrscan.session")

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    setupSession()
    addCancelButton()
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    sessionQueue.async { [weak self] in self?.session?.stopRunning() }
  }

  private func setupSession() {
    sessionQueue.async { [weak self] in
      guard let self = self else { return }
      let session = AVCaptureSession()
      guard
        let device = AVCaptureDevice.default(for: .video),
        let input = try? AVCaptureDeviceInput(device: device)
      else {
        DispatchQueue.main.async { self.onResult?(nil); self.dismiss(animated: true) }
        return
      }
      session.addInput(input)
      let output = AVCaptureMetadataOutput()
      session.addOutput(output)
      output.setMetadataObjectsDelegate(self, queue: .main)
      output.metadataObjectTypes = [.qr]
      DispatchQueue.main.async {
        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = self.view.bounds
        preview.videoGravity = .resizeAspectFill
        self.view.layer.insertSublayer(preview, at: 0)
      }
      self.session = session
      session.startRunning()
    }
  }

  private func addCancelButton() {
    let btn = UIButton(type: .system)
    btn.setTitle("Cancel", for: .normal)
    btn.setTitleColor(.white, for: .normal)
    btn.titleLabel?.font = .systemFont(ofSize: 17)
    btn.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(btn)
    NSLayoutConstraint.activate([
      btn.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -20),
      btn.centerXAnchor.constraint(equalTo: view.centerXAnchor)
    ])
    btn.addTarget(self, action: #selector(cancel), for: .touchUpInside)
  }

  @objc private func cancel() {
    sessionQueue.async { [weak self] in
      self?.session?.stopRunning()
      DispatchQueue.main.async { self?.dismiss(animated: true) { self?.onResult?(nil) } }
    }
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput objects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard let obj = objects.first as? AVMetadataMachineReadableCodeObject,
          let value = obj.stringValue else { return }
    sessionQueue.async { [weak self] in
      self?.session?.stopRunning()
      DispatchQueue.main.async { self?.dismiss(animated: true) { self?.onResult?(value) } }
    }
  }
}
