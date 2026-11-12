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

## Peer route

When no saved host answers, the app reaches the Mac over Apple peer-to-peer Wi-Fi, which needs no shared network.

- The Mac advertises `_agentbrief._tcp` as `ab-` plus the first 16 characters of its certificate fingerprint. The app derives the same name from the fingerprint it paired with.
- `PeerBridge.swift` browses for that name and listens on `127.0.0.1`. Each loopback connection becomes a raw TCP pipe to the Mac's TLS listener, so URLSession, the pinned certificate and the credential stay the same.
- `LanClient` tries the route that worked last. Without one, it gives every saved host 1.5 s to accept a connection while the bridge starts. If none does, it uses the bridge once the Mac's service shows up, up to 6 s after the search began.
- A working peer route stays in use until it fails or the network changes. Then the LAN goes first again.
- Bridges stop when the app leaves the foreground or a Mac is unpaired, and pause while the LAN works.

The simulator has no peer-to-peer Wi-Fi. `PeerRouteTests` stands in with a stub that registers its port under the derived name with `dns-sd -R` on the Mac's own network, and a pairing link whose hosts never answer. It pairs, lists, opens and sends over the bridge, and fails if the list takes 8 s or more.

`AB_PEER_HELPER=$PWD/bin/agent-brief-peer AB_ONLY=PeerRouteTests node ios/test/run-sim.mjs` puts the Mac's real helper in front of the stub in place of `dns-sd`, so the app's bridge and the helper meet.

`node ios/test/run-device-peer.mjs <udid>` runs `DevicePeerTests` on a real, unlocked device against `live/ipad-stub.mjs` with the helper. The Mac side listens on loopback alone, so the helper is the one way in. The device keeps its pairings: the test adds a Mac named Peer Check Mac and forgets only that one. The runner prints which Mac interface carried the device's connections. `--sim` runs the same test on a simulator.

## Test

`node ios/test/run-sim.mjs` runs the UI test on a simulator against `ios/test/stub-server.mjs` and checks what the stub received. `src/ipad-client/capture.test.ts` runs in `pnpm test`.

`node ios/test/tour-sim.mjs <out-dir> [light|dark] [landscape|portrait]` walks every screen on a simulator and writes screenshots to `<out-dir>`, for checking UI changes by eye.
