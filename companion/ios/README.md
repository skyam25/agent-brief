# Agent Brief for iPad

Native iPad companion. The board is the web client in `src/ipad-client/`, bundled into a SwiftUI app. Dictation runs on the iPad.

## Build

From `companion/`, run `pnpm build:ipad`. It builds `ios/AgentBrief/Web/` and generates `ios/AgentBrief.xcodeproj` with XcodeGen.

## Install on an iPad

```
cd ios
xcodebuild -project AgentBrief.xcodeproj -scheme AgentBrief -destination 'generic/platform=iOS' -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl device install app --device <udid> build/Build/Products/Debug-iphoneos/AgentBrief.app
```

`xcrun devicectl list devices` shows the udid.

## Pair

On the Mac, choose Pair iPad… in Agent Brief. On the iPad, tap Scan QR Code and point the camera at the code. The Camera app also works, and so does pasting the link into the app.

## Test

`node ios/test/run-sim.mjs` runs the UI test on a simulator against `ios/test/stub-server.mjs` and checks what the stub received. `src/ipad-client/capture.test.ts` runs in `pnpm test`.

`node ios/test/tour-sim.mjs <out-dir> [light|dark] [landscape|portrait]` walks every screen on a simulator and writes screenshots to `<out-dir>`, for checking UI changes by eye.
