import AVFoundation
import SwiftUI
import VisionKit

/// Opens the camera to read the pairing QR code that the Mac shows.
struct ScanButton: View {
  @Environment(AppModel.self) private var model
  @State private var scanning = false

  /// False on the simulator and on devices without a supported camera.
  static var supported: Bool { DataScannerViewController.isSupported }

  var body: some View {
    Button("Scan QR Code", systemImage: "qrcode.viewfinder") { scanning = true }
      .buttonStyle(.borderedProminent)
      .controlSize(.large)
      .disabled(model.isPairing)
      .accessibilityIdentifier("scan-button")
      .sheet(isPresented: $scanning) {
        ScanSheet { link in
          scanning = false
          model.pair(scanned: link)
        }
      }
  }
}

private struct ScanSheet: View {
  let found: (PairLink) -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var access: Access = .asking
  @State private var wrongCode = false

  private enum Access { case asking, granted, denied }

  var body: some View {
    NavigationStack {
      Group {
        switch access {
        case .asking:
          ProgressView()
        case .granted:
          QRScanner(found: found, wrongCode: { wrongCode = true })
            .ignoresSafeArea(edges: .bottom)
            .overlay(alignment: .bottom) { caption }
        case .denied:
          ContentUnavailableView {
            Label("Camera Is Off", systemImage: "camera")
          } description: {
            Text("Turn on Camera for Agent Brief in Settings, or paste the pairing link instead.")
          } actions: {
            Button("Open Settings") { openURL(URL(string: UIApplication.openSettingsURLString)!) }
          }
        }
      }
      .navigationTitle("Scan the Mac's Code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
    }
    .task {
      let granted = await AVCaptureDevice.requestAccess(for: .video)
      access = granted && DataScannerViewController.isAvailable ? .granted : .denied
    }
  }

  private var caption: some View {
    Text(wrongCode ? "That isn't a pairing code." : "Point the camera at the pairing code on the Mac.")
      .font(.callout)
      .padding(.horizontal, 16)
      .padding(.vertical, 10)
      .background(.regularMaterial, in: .capsule)
      .padding(.bottom, 32)
      .accessibilityIdentifier("scan-caption")
  }
}

private struct QRScanner: UIViewControllerRepresentable {
  let found: (PairLink) -> Void
  let wrongCode: () -> Void

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      isHighlightingEnabled: true
    )
    scanner.delegate = context.coordinator
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {
    context.coordinator.parent = self
    if !scanner.isScanning { try? scanner.startScanning() }
  }

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  @MainActor
  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    var parent: QRScanner
    private var done = false

    init(_ parent: QRScanner) { self.parent = parent }

    func dataScanner(_ scanner: DataScannerViewController, didAdd added: [RecognizedItem], allItems: [RecognizedItem]) {
      guard !done else { return }
      for item in added {
        guard case .barcode(let code) = item, let text = code.payloadStringValue else { continue }
        if let url = URL(string: text), let link = PairLink(url: url) {
          done = true
          scanner.stopScanning()
          parent.found(link)
          return
        }
        parent.wrongCode()
      }
    }
  }
}
