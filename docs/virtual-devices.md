# Lumen camera and microphone

The desktop integration publishes the finished Program picture as **Lumen
Camera** and the Main mix as **Lumen Microphone**, with 1280 × 720 video at
30 fps and stereo 48 kHz audio. Native implementations are included for macOS
13+ and x64 Windows 10 (2004/build 19041 or newer) and Windows 11. Browser-only
installations cannot register operating-system devices.

**Current validation:** the macOS components compile and pass native, browser
capture and packaged desktop smoke tests. The Windows PCM loopback tests pass
on this Mac; the Windows SDK/WDK components have not been compiled or installed
here. No signed devices have been installed or tested in Zoom/OBS on either OS.
Apple signing credentials and a Microsoft-signed Windows audio driver package
are required before this feature is usable in a normal desktop release.

## Using the devices

### macOS

1. Install the signed Lumen desktop app in Applications.
2. In **Studio → Outputs → Camera & microphone**, choose **Enable camera**.
   Approve Lumen in macOS’s Camera Extensions settings when prompted.
3. Choose **Install microphone**, complete the standard macOS administrator
   installer, then restart the Mac to load the audio plugin.
4. Choose **Start sending Program**. This starts the production engine if needed.
5. In Zoom or OBS, select **Lumen Camera** for video and **Lumen Microphone** for
   audio. Restart the receiving app if it was open during installation.

### Windows

1. Install a signed x64 Lumen desktop release containing signed device components.
2. In **Studio → Outputs → Camera & microphone**, choose **Install camera & microphone**.
   Complete the separate administrator installer; restart if requested.
3. Choose **Start sending Program** and select **Lumen Camera** and **Lumen
   Microphone** in the receiving app. Reopen apps that were running during setup.
4. To remove the devices, use **Lumen Camera and Microphone** in Windows Installed
   apps. Quit apps using the devices first. The uninstaller is available even if
   setup only partially completed.

The Windows camera uses DirectShow for Windows 10/11 desktop compatibility.
This first build targets 64-bit desktop clients; 32-bit clients, ARM64 Windows
and Media Foundation-only camera consumers are not supported.

The receiver runs in its own hidden desktop window and stays connected while
the operator navigates between channels and Studio. **Stop sending**, sign-out,
loss of operator access, or quitting Lumen stops delivery. A camera client that
remains connected gets black within 500 ms of lost video; audio drains to silence.
Starting delivery is explicit on each app launch. Lumen does not select new default microphones or speakers; its native devices
are configured not to become system defaults. The loopback device also exposes an output side
for Lumen’s native bridge; keep Zoom’s speaker output on normal headphones or
speakers to avoid a feedback loop.

## Architecture

- `StudioVirtualOutputView.vue` receives the existing authenticated Program
  WebRTC stream. Canvas scales and converts pixels to BGRA. An AudioWorklet
  captures the Program audio track at 48 kHz without playing it through speakers.
- Two narrow IPC methods are accepted only from the dedicated receiver’s main
  frame. Control operations require an authenticated global author or admin.
  Access is checked again periodically and session-cookie removal stops delivery.
- `virtual-device-transport.cjs` permits one pending video and one pending audio
  packet. A versioned, length-checked pipe protocol connects to `LumenDeviceBridge`.
  Slow consumers drop frames instead of accumulating latency or memory.
- On macOS, the bridge feeds a CoreMediaIO sink stream. `CameraExtension.swift` publishes
  a source stream to camera clients and accepts a producer only when its signing
  identity and Apple team match Lumen’s bridge. Stable device and stream UUIDs
  keep app selections consistent across launches.
- The bridge’s AudioUnit writes to `LumenAudio.driver`. The HAL plugin provides
  an input/output loopback device with independent readers, timestamped stereo
  samples and 1024 frames of input latency. Silence is returned for missing or
  expired sample positions. Only the media callback handlers use the bounded
  audio rings; they do not allocate or perform filesystem work.
- Camera activation runs in the provisioned Electron main app through a small
  stable Node-API addon. The media bridge has no system-extension installation
  entitlement. No driver installation or activation runs automatically at launch.

- On Windows, the bridge feeds a fixed-format DirectShow camera over bounded,
  session-local shared memory and sends 48 kHz float PCM through WASAPI to
  **Lumen Program Send**. A WaveRT driver loops the render mix (16-bit stereo)
  into the capture endpoint (32-bit stereo). The ring has a 20 ms target delay,
  independent read cursors and silence on expired input. Windows' shared audio
  engine handles conversion, shared-mode endpoint volume/mute and multiple app
  clients; the driver does not advertise the sample’s fake hardware controls. Private endpoint property
  markers identify Lumen devices even when Windows or a user renames them.
- The Windows installer registers only Lumen's camera CLSID and creates only
  `ROOT\LumenAudio`. The normal app stays unelevated. Kernel driver signing is
  enforced by Windows; the build does not enable test mode or change Secure Boot.

## Building on macOS

Requires macOS, Xcode command-line tools, and the repository’s usual desktop
dependencies. Native sources and dependency headers are vendored with licenses;
the native build does not download dependencies or require CMake.

```sh
npm run prepare:virtual-devices --prefix desktop
npm run test:virtual-devices --prefix desktop
npm run build --prefix frontend
node backend/test/virtual-devices-browser.mjs
```

Unsigned builds compile, enumerate existing devices and run tests, but explicitly
disable installation and activation in the UI. They are not usable as a camera
in Zoom. There is no signing or system-protection bypass.

For distribution, provide these build-environment values:

| Variable | Value |
| --- | --- |
| `CSC_NAME` | Installed Developer ID Application signing identity |
| `LUMEN_APPLE_TEAM_ID` | Ten-character Apple Developer team identifier |
| `LUMEN_INSTALLER_IDENTITY` | Installed Developer ID Installer identity |
| `LUMEN_HOST_PROFILE` | Developer ID provisioning profile for `app.lumen.studio`, authorizing System Extension installation |
| `LUMEN_CAMERA_PROFILE` | Developer ID provisioning profile for `app.lumen.studio.camera` |
| `LUMEN_NOTARY_PROFILE` | Optional `notarytool` keychain profile used to notarize and staple the audio installer |
| `APPLE_KEYCHAIN_PROFILE` | Electron builder notarization keychain profile for the containing app |

Configure the camera’s app group as `TEAMID.app.lumen.studio.camera`. Profiles,
certificates and signing credentials are supplied locally or by the release
system; do not commit them. The build checks profile expiration, app identifiers,
team identifiers and the host installation entitlement before signing. Signed
release preparation requires both profiles and both signing identities.

`npm run prepare:bundle --prefix desktop` builds the native devices as part of
normal platform preparation. `npm run package:dir --prefix desktop` embeds the camera
in `Contents/Library/SystemExtensions`, the producer in `Contents/MacOS`, the
activation addon and audio installer under `Contents/Resources/virtual-devices`,
and the host profile in `Contents/embedded.provisionprofile`. The packager
preserves native component signatures and rejects architecture/team mismatches.
Use the host architecture for a complete app package; `LUMEN_NATIVE_ARCH=x64`
can cross-compile native components on Apple Silicon for compile checking.

Notarize and staple **both** the containing app and the microphone installer
before distributing them. The installer deliberately does not kill CoreAudio
or interrupt a live session; the operator restarts the Mac after installation.

## Building on the Windows PC

Use an x64 Windows PC with Visual Studio 2022 C++ desktop tools, its matching
Windows SDK and WDK (including the Visual Studio WDK extension), CMake 3.21+,
NSIS 3 and Node.js. Use an **x64 Native Tools Command Prompt** so `cl`, `MSBuild`,
`cmake`, `ctest` and `signtool` are available. Put NSIS on PATH or set
`LUMEN_MAKENSIS` to the full path of `makensis.exe`.

From the repository root:

```bat
npm ci --prefix desktop
npm run prepare:virtual-devices --prefix desktop
npm run test:virtual-devices --prefix desktop
```

Preparation builds the DirectShow DLL and media bridge with MSVC, runs CTest
(camera shared-memory and PCM tests), builds the WaveRT driver with the WDK,
and creates `desktop/build/virtual-devices/LumenDevicesSetup.exe`. Tests do not
install devices. An unsigned build is for compilation/testing only; the Studio
UI keeps installation and sending disabled. Preserve the complete build output
if any Windows compiler or WDK validation step fails.

For a release, submit the WDK-produced driver package through Microsoft's
hardware driver signing process. Set these environment values and run preparation
again:

| Variable | Value |
| --- | --- |
| `LUMEN_WINDOWS_SIGNED_DRIVER` | Directory containing the returned Microsoft-signed `LumenAudio.inf`, `.sys` and `.cat` |
| `LUMEN_WINDOWS_CERT_SHA1` | Thumbprint of the installed Authenticode signing certificate for the camera, bridge and device installer |
| `LUMEN_WINDOWS_TIMESTAMP_URL` | Optional RFC 3161 timestamp URL (defaults to DigiCert) |
| `LUMEN_MAKENSIS` | Optional full NSIS compiler path |

The driver targets KMDF 1.31 so it can load on Windows 10 2004 as well as Windows
11. The build checks the driver's catalog against both SYS and INF with
`signtool verify /kp`, signs the user-mode binaries and installer, then marks the
manifest signed. An ordinary application certificate does not satisfy kernel
driver signing. Use the existing Electron builder signing configuration for the
containing Lumen app as well. After `npm run prepare:bundle --prefix desktop`,
`npm run package:dir --prefix desktop` embeds the native bridge, camera DLL and
separate elevated device installer in `resources/virtual-devices`.
Run `node desktop/scripts/test-virtual-devices-desktop.mjs` to smoke-test the
packaged app in a disposable profile; this does not install or activate devices.

## Validation and release gate

Automated checks cover binary framing, rejected malformed packets, bounded
backpressure, helper crashes, operator permissions, audio-worklet stereo/mono
behavior, ring wraparound/concurrency/silence, and the compiled HAL plugin’s
device properties and input/output callbacks. The browser test uses a disposable
station, generated video colours and stereo tone to exercise the actual Program
peer, scaling, audio capture, scene switching and engine-stop cleanup.

These tests do not replace an installed-device test. Before shipping, use a
signed, notarized app on a Mac and a signed app/driver package on both Windows
10 and 11 with system protections enabled. Install the devices and verify:

- Zoom and OBS list both devices; picture and Main audio arrive together.
- Main mute/volume and scene changes affect the output, with acceptable lip sync.
- Windows shared-mode endpoint volume/mute works; installing does not change defaults.
- Multiple camera/microphone clients work at once and reconnect after app restart.
- Channel/Studio navigation and minimizing Lumen preserve delivery.
- Stop, sign-out, producer crash, engine loss and app quit produce black/silence.
- Updating the installed app and camera extension preserves saved selections.

Without Apple signing identities and provisioning profiles, installed-camera
activation remains unverified. Windows compilation, driver installation and
Zoom/OBS interoperability on both platforms remain release gates. A Windows PC
is available for the next validation step; its build tools and signing setup
have not been inspected from this environment.

To remove the microphone, quit apps using it, remove only
`/Library/Audio/Plug-Ins/HAL/LumenAudio.driver` in Finder with administrator
approval, and restart. The camera can be disabled in macOS Camera Extensions
settings; removing its containing app lets macOS manage its removal.

## Upstream references

- [Apple: creating a camera extension](https://developer.apple.com/documentation/coremediaio/creating-a-camera-extension-with-core-media-i-o)
- [Apple: creating an audio server driver plugin](https://developer.apple.com/documentation/coreaudio/creating-an-audio-server-driver-plug-in)
- [Apple DTS: provisioning the system-extension installation entitlement](https://developer.apple.com/forums/thread/811067)
- [libASPL](https://github.com/gavv/libASPL), pinned provenance and MIT/Apple licenses in `desktop/native/macos/vendor/libASPL`.
- [Node-API](https://nodejs.org/api/n-api.html), v22.13.0 headers and license in `desktop/native/macos/vendor/node-api`.

- [Softcam](https://github.com/tshino/softcam), pinned MIT source with Lumen changes in `desktop/native/windows/vendor/softcam`.
- [Microsoft Simple Audio Sample](https://github.com/microsoft/Windows-driver-samples/tree/main/audio/simpleaudiosample), pinned MIT source with Lumen loopback changes in `desktop/native/windows/vendor/simple-audio`.
- [Microsoft kernel driver signing](https://learn.microsoft.com/en-us/windows-hardware/drivers/install/kernel-mode-code-signing-policy--windows-vista-and-later-).
- [Microsoft audio endpoint default-device policy](https://learn.microsoft.com/en-us/windows-hardware/drivers/audio/pkey-audiodevice-neversetasdefaultendpoint).
