# padSync for iPad (native)

A native shell around padSync for the 13" iPad Pro with Apple Pencil Pro. The notebook editor is
native (PencilKit); library, AI import, chat and settings are the deployed web app in a
WKWebView. Design and phases: [../docs/ios-native-2026-11-21.md](../docs/ios-native-2026-11-21.md).

## One-time setup (free Apple ID)

1. Install Xcode, open it once, add your Apple ID in **Settings → Accounts**. A "Personal Team"
   appears; that's the free signing team.
2. `brew install xcodegen`
3. `cp Config/Local.xcconfig.example Config/Local.xcconfig` and set `DEVELOPMENT_TEAM` to your
   team id (Xcode → Settings → Accounts → your Apple ID shows it, or pick the team once in the
   target's *Signing & Capabilities* tab and copy it from there).
4. On the iPad: **Settings → Privacy & Security → Developer Mode** on (restarts). Connect it to
   the Mac with USB-C and tap *Trust*.

## Build and install

```bash
cd ios
xcodegen                    # regenerate PadSync.xcodeproj after pulling or editing project.yml
open PadSync.xcodeproj      # pick the iPad as the run destination, press ⌘R
```

First launch on the iPad says *Untrusted Developer*: **Settings → General → VPN & Device
Management →** your Apple ID → **Trust**.

From the command line instead (iPad connected or on the same Wi-Fi after the first USB run):

```bash
xcodebuild -project PadSync.xcodeproj -scheme PadSync -destination 'platform=iOS,name=<iPad name>' \
  -derivedDataPath build -allowProvisioningUpdates build
xcrun devicectl device install app --device '<iPad name>' build/Build/Products/Debug-iphoneos/padSync.app
```

**Free accounts expire the install after 7 days.** The app then won't open; build and run again
(data stays). At most 3 side-loaded apps per device.

## Layout

| Path | What |
| --- | --- |
| `project.yml` | XcodeGen spec (the `.xcodeproj` is generated, not committed) |
| `Config/Base.xcconfig` | `PADSYNC_HOST` (deployment), `PADSYNC_BUNDLE_ID` |
| `PadSync/Web/WebScreen.swift` | WKWebView; sends `/notebook?id=…` to the native editor |
| `PadSync/Notebook/` | native editor (phase 1: PencilKit scratch canvas) |
| `PadSync/Server.swift` | server URL, web sign-in cookie for native requests |
| `scripts/make-icon.swift` | renders the app icon (same as `src/app/icon.tsx`) |

The web app detects the native shell through `window.webkit.messageHandlers.padsync`
(`src/lib/native.ts`) and posts `{ type: "openNotebook", id }` instead of routing. Debug the
web half from the Mac: Safari → Develop → (iPad) → padSync.
