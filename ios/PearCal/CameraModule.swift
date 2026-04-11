import UIKit
import PhotosUI
import UniformTypeIdentifiers

@objc(PearCalCamera)
class CameraModule: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate, PHPickerViewControllerDelegate {

  private var captureResolve: RCTPromiseResolveBlock?
  private var captureReject: RCTPromiseRejectBlock?

  @objc func capture(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    captureResolve = resolve
    captureReject = reject
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let alert = UIAlertController(title: nil, message: nil, preferredStyle: .actionSheet)
      alert.addAction(UIAlertAction(title: "Take Photo", style: .default) { _ in self.openCamera() })
      alert.addAction(UIAlertAction(title: "Choose from Library", style: .default) { _ in self.openGallery() })
      alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
        self?.captureReject?("CANCELLED", "Cancelled", nil)
        self?.captureResolve = nil
        self?.captureReject = nil
      })
      alert.popoverPresentationController?.sourceView = UIApplication.shared.connectedScenes
          .compactMap({ $0 as? UIWindowScene })
          .first?.windows.first?.rootViewController?.view
      self.presentFrom(alert)
    }
  }

  private func openCamera() {
    guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
      captureReject?("NO_CAMERA", "Camera not available", nil)
      captureResolve = nil; captureReject = nil
      return
    }
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = self
    presentFrom(picker)
  }

  private func openGallery() {
    var config = PHPickerConfiguration()
    config.filter = .images
    config.selectionLimit = 1
    let picker = PHPickerViewController(configuration: config)
    picker.delegate = self
    presentFrom(picker)
  }

  private func presentFrom(_ vc: UIViewController) {
    guard let root = UIApplication.shared.connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .first?.windows.first?.rootViewController else { return }
    var presenter = root
    while let presented = presenter.presentedViewController { presenter = presented }
    presenter.present(vc, animated: true)
  }

  func imagePickerController(
    _ picker: UIImagePickerController,
    didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
  ) {
    picker.dismiss(animated: true)
    guard let image = info[.originalImage] as? UIImage else {
      captureReject?("NO_IMAGE", "No image returned", nil)
      captureResolve = nil; captureReject = nil
      return
    }
    resolveWithImage(image)
  }

  func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
    picker.dismiss(animated: true)
    captureReject?("CANCELLED", "Cancelled", nil)
    captureResolve = nil; captureReject = nil
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    picker.dismiss(animated: true)
    guard let provider = results.first?.itemProvider else {
      captureReject?("CANCELLED", "Cancelled", nil)
      captureResolve = nil; captureReject = nil
      return
    }

    // Try GIF first, then WebP — preserve animated formats as raw data
    if provider.hasItemConformingToTypeIdentifier(UTType.gif.identifier) {
      provider.loadDataRepresentation(forTypeIdentifier: UTType.gif.identifier) { [weak self] data, _ in
        guard let data = data else {
          self?.captureReject?("NO_IMAGE", "Could not load GIF", nil)
          self?.captureResolve = nil; self?.captureReject = nil
          return
        }
        self?.captureResolve?("data:image/gif;base64,\(data.base64EncodedString())")
        self?.captureResolve = nil; self?.captureReject = nil
      }
    } else if provider.hasItemConformingToTypeIdentifier(UTType.webP.identifier) {
      provider.loadDataRepresentation(forTypeIdentifier: UTType.webP.identifier) { [weak self] data, _ in
        guard let data = data else {
          self?.captureReject?("NO_IMAGE", "Could not load WebP", nil)
          self?.captureResolve = nil; self?.captureReject = nil
          return
        }
        self?.captureResolve?("data:image/webp;base64,\(data.base64EncodedString())")
        self?.captureResolve = nil; self?.captureReject = nil
      }
    } else if provider.canLoadObject(ofClass: UIImage.self) {
      provider.loadObject(ofClass: UIImage.self) { [weak self] object, _ in
        guard let image = object as? UIImage else {
          self?.captureReject?("NO_IMAGE", "Could not load image", nil)
          self?.captureResolve = nil; self?.captureReject = nil
          return
        }
        self?.resolveWithImage(image)
      }
    } else {
      captureReject?("NO_IMAGE", "Unsupported image format", nil)
      captureResolve = nil; captureReject = nil
    }
  }

  private func resolveWithImage(_ image: UIImage) {
    let maxDim: CGFloat = 512
    let scale = min(maxDim / max(image.size.width, image.size.height), 1.0)
    let newSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
    let renderer = UIGraphicsImageRenderer(size: newSize)
    let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
    guard let jpeg = resized.jpegData(compressionQuality: 0.8) else {
      captureReject?("ENCODE_ERROR", "Failed to encode image", nil)
      captureResolve = nil; captureReject = nil
      return
    }
    captureResolve?("data:image/jpeg;base64,\(jpeg.base64EncodedString())")
    captureResolve = nil; captureReject = nil
  }

  @objc static func requiresMainQueueSetup() -> Bool { return false }
}
