# Lumen on Windows, Mac and the web

The desktop edition packages the existing Lumen web interface and local server
inside Electron. The source-based web edition continues to use the same frontend,
backend and `.lumen` data format. Desktop users do not need Git, Node.js, npm,
Chrome, FFmpeg or a terminal to operate their station.

## Install on the church Windows laptop

1. Download the Windows installer, `Lumen-<version>-win-x64-setup.exe`, from the
   build supplied for this test. Use this installer on a 64-bit Intel or AMD
   Windows 10/11 computer. Windows ARM packages are not included in this build.
2. Run the installer, then open **Lumen** from the Start menu or desktop shortcut.
   The application starts its local server automatically.
3. Sign into the new station with **admin / admin**. Open your profile menu,
   choose **Team & roles**, and change that password.
4. Open **profile image → Data settings → Import**, choose your `.lumen` file,
   select **Preview file**, review the selected content, then **Import selected**.
5. Connect your camera through its capture card. In Studio, add a Camera source,
   allow camera access, select the card and check its preview. Device selections
   are specific to the laptop; choose resolution, frame rate and audio again.
6. Click **Start engine**. Check the external display, playback and recording
   before using the station for a service.

The first desktop package is a test build. If it is unsigned, Windows may show an
unrecognized publisher warning. A signed distribution requires a configured
publisher certificate; packaging alone does not provide that identity. Use only
the exact installer provided by the Lumen project.

## Install on a Mac

Choose the **arm64** build for Apple silicon or **x64** for an Intel Mac. Open
`Lumen-<version>-mac-<arch>.dmg`, drag **Lumen** into **Applications**, then open it.
Follow the same sign-in and import steps as Windows. Allow camera and microphone
access when requested. Screen sharing may also require permission in macOS
**System Settings → Privacy & Security → Screen & System Audio Recording**.

Development builds are not Developer ID signed or Apple notarized unless signing
credentials were configured when packaging. macOS may therefore block the first
launch. Verify the build's source and use macOS's approval flow for that app;
do not disable Gatekeeper globally.

## Move your library from the development Mac

In the existing Lumen station, open **profile image → Data settings → Export**.
Select the Bibles, songs, media, presentations, scenes and other content you want
to take, then export the `.lumen` file. Copy it to the destination computer and
import it there. Accounts and device-specific camera/microphone selections remain
local. The installer contains no development-station accounts, media, scenes,
recordings or screenshots.

## Daily use and saved data

In Studio output setup, use **Find displays** and assign a connected screen.
The desktop app opens assigned outputs fullscreen automatically, including after
reopening Lumen. **Esc** exits fullscreen; **F** or the Fullscreen button toggles
it. **Manual window** opens windowed. Assignments stay on this computer; if an
assigned display disconnects, its output closes rather than moving onto the
operator's screen. Reconnect the screen and open the output again.

Open Lumen using its app icon. The backend and required runtimes start with the
app; there is no command window to keep open. Keep the Lumen app running during
production. Stopping a recording before quitting lets it finish saving. Quitting
the desktop app stops its local engine and outputs.

While the engine is starting/running or a recording is active, the desktop app
prevents idle display sleep, including when its controls are minimized. It
releases that protection after stopping. This does not disable manual locking,
override lid closure, or change system power settings; rehearse with the display
awake before a service.

Use **File → Open data folder** to locate this station's data. It is separate
from the installed application, under the operating system's per-user application
data folder. Application upgrades reuse that station rather than replacing its
library. A fresh install on another computer creates a fresh station. Make a
`.lumen` export or copy the station folder while Lumen is closed before moving
machines or removing local data.

For AssemblyAI listening, place `ASSEMBLYAI_API_KEY=your-key` in a private `.env`
file inside the station folder shown by **File → Open data folder**. The default
Mac location is `~/Library/Application Support/Lumen/station/.env`. Restrict the
file to your user (`chmod 600` on macOS). This station setting survives app
updates and works when opening Lumen from Finder. Only the AssemblyAI key is
read from this file; it is not sent to the interface or copied into an installer.
A process environment key takes precedence, followed by a project-root `.env`
key, then the station key. Listening checks the setting when starting a session.
Choose **AssemblyAI** in Scripture listening controls;
Notes can link to that same active transcript without another microphone stream.

Notes is also a dedicated channel in the dock. Existing Notes-only channels
upgrade in place, preserving their slides, private drafts and transcripts;
Notes in mixed presentations stay where they are. In Studio, use **New source →
Lumen channel** to add Notes, select its layer, then choose **Full screen**, **Bottom** or
**Top** in the inspector. Full screen uses the saved slide design. Bottom and
Top use the layer's own text and background controls over the scene.

Original recordings are in the `recordings` subfolder of that station folder.
The **Recordings → Storage** window shows its exact path. To put future
recordings on another drive, close Lumen, move the **entire station folder**
there, and set the user environment variable `LUMEN_DATA_DIR` to the moved
folder's absolute path before reopening Lumen. On Windows, for example, run
the following in PowerShell, then sign out and in so the Start menu uses the
new environment variable:

```powershell
[Environment]::SetEnvironmentVariable('LUMEN_DATA_DIR', 'D:\Lumen\station', 'User')
```

Keep `recordings`, `clips`, and the other station files together; saved clip
projects refer to originals in that folder. The **Delete recording** action
removes an original from the library only when no retained clip project or
export needs it. Lumen places a recovery copy in `backups/data-clear` inside
the station folder, so deleting from the library does not immediately reclaim
disk space. Review and remove old backups from the data folder separately when
you are certain they are no longer needed.

The package includes Electron, a Node.js runtime, the production Chromium
renderer, Windows/Mac FFmpeg and native database/image libraries. It also includes
the local Whisper runtime and the **Base English** listening model. Larger and
multilingual listening models are optional; installing them is separate from
the core desktop setup. Cloud collaboration and remote streaming still need
their normal network/service configuration.

Full audience outputs prefer H.264 when both endpoints support it. Once the
running sender confirms H.264, it may use up to 8 Mbps; congestion control still
adapts to available bandwidth. Other negotiated codecs retain their previous
bitrate settings. Compact operator previews, Multiview, phone monitoring, input
publishing and recording keep their existing encoding settings. Output
diagnostics report the negotiated codec and configured bitrate ceiling. Initial
connection bandwidth estimation can briefly reduce resolution before full HD
settles; a frame-rate check alone does not prove full-resolution delivery.
If a connected preferred encoder repeatedly reports zero frames, the affected
viewer retries with the browser's default codec and bitrate. That decision is
retained for that viewer until it disconnects, while other viewers keep their
encoding settings. Missing or failed stats alone do not trigger a codec change.

## Building a desktop package

These instructions are for the computer producing the installer. Computers
receiving that installer do not need any of these build tools.
Build on the target operating system and architecture: Windows x64, Mac arm64 or
Mac x64. Native database/image dependencies, FFmpeg and the bundled Node runtime
must match that target. Do not copy the Mac's `node_modules` into Windows.

### Build the Windows installer locally

Install these on the Windows build computer:

- Git for Windows, Node.js **22 x64**, and CMake for Windows. In the CMake
  installer, enable its **Add CMake to PATH** option.
- Visual Studio 2022 Build Tools with **Desktop development with C++**, including
  the MSVC compiler and a Windows SDK. This compiles the bundled Whisper runtime;
  people installing Lumen do not need a compiler.
- [MSYS2](https://www.msys2.org/) in its default `C:\msys64` folder. Its MinGW
  compiler builds the bundled FFmpeg and codecs from the included source set.

Open the **MSYS2 MINGW64** terminal and update its packages:

```sh
pacman -Suy
```

If the update asks to close the terminal, reopen **MSYS2 MINGW64** and run that
update command again. This is MSYS2's [normal full-update procedure](https://www.msys2.org/docs/updating/).
Then install the build tools, accepting the default package selection:

```sh
pacman -S --needed base-devel mingw-w64-x86_64-toolchain perl diffutils
```

Close the MSYS2 terminal when installation finishes. The Lumen build invokes
its compiler automatically; do not run the npm commands below inside MSYS2.

Open a new **Developer PowerShell for VS 2022** window after installation. Run
each command only after the preceding command succeeds:

```powershell
cd $HOME
git clone --branch codex/windows-church-test https://github.com/Xybron/Lumen.git
cd Lumen
node --version
cmake --version

npm.cmd ci
npm.cmd --prefix frontend ci
npm.cmd --prefix backend ci
npm.cmd run desktop:install
npm.cmd run desktop:test
npm.cmd run desktop:package
npm.cmd run desktop:smoke
```

`node --version` must report `v22...`. Authenticate to GitHub if requested using
an account with access to the repository. If this checkout already exists, open
that folder and use `git pull --ff-only` instead of cloning a second copy.
If MSYS2 was installed elsewhere, set
`$env:LUMEN_MSYS2_ROOT = 'D:\msys64'` (using its actual folder) in the same
PowerShell window before `desktop:package`.
Use an MSYS2 installation folder without spaces; the repository folder may
contain spaces.

The build needs internet access to obtain its pinned runtimes, the browser and
the default speech model. The first FFmpeg/codec source build takes several
minutes; later builds reuse their compiler cache. The generated installer bundles
those files, so the recipient does not repeat the downloads to run the local
application.

When the build and smoke check succeed, the installer is:

```text
desktop\dist\Lumen-1.0.0-win-x64-setup.exe
```

`desktop\dist\SHA256SUMS.txt` contains its checksum. Run the installer on the
church laptop, then follow the first-run and import steps above. The native
Windows build and smoke check must be run on Windows; a successful Mac build
does not verify the Windows executable.

### Build on a Mac

Install Git, Node.js 22 for the Mac's architecture, and Apple's Xcode Command
Line Tools (`xcode-select --install`). The preparation script obtains CMake when
it is absent. From the repository root, run:

```sh
npm ci
npm --prefix frontend ci
npm --prefix backend ci
npm run desktop:install
npm run desktop:test
npm run desktop:package
npm run desktop:smoke
```

The desktop scripts build the existing web application, prepare an allowlisted
resource tree and package it with Electron Builder. They do not require GitHub
Actions. The normal web build and `npm start` commands remain available.

The staging area is `desktop/build/resources`; distributables go into
`desktop/dist`. Neither directory belongs in Git. The package includes compiled
application code and runtime assets only. Station `data/`, `.env` files, screenshots
and working-directory secrets must never be copied into the resource tree.

For a native unpacked build, run the packaged smoke check. Without arguments it
finds the current platform's build in `desktop/dist`:

```sh
node desktop/scripts/smoke.mjs
```

You can also select an explicit Mac application:

```sh
node desktop/scripts/smoke.mjs --app /absolute/path/to/Lumen.app
```

On Windows, pass the unpacked executable instead:

```powershell
node desktop/scripts/smoke.mjs --app .\desktop\dist\win-unpacked\Lumen.exe
```

The smoke check restricts PATH to system tools, runs two disposable stations,
checks bundled native dependencies, warms up the bundled Whisper model without
a microphone, signs in, exports and imports a synthetic
`.lumen` archive, starts the bundled production browser, makes a short recording,
and checks shutdown. While recording generated 1080p motion, it measures the
output for 12 seconds with the operator window visible and another 12 seconds
with that window minimized. Both phases require at least 20 presented frames per
second, no one-second frame gap, and changes in the decoded picture. The retained
`output-continuity.json` includes actual received resolution, frame gaps, dropped
frames and renderer diagnostics; WebRTC may reduce transmitted resolution under
load, so passing this check does not establish full-HD delivery or a sustained
30 fps service. It tests the package selected by `--app`, not unbundled source
changes. It never reads the operator's station or opens a physical
camera/microphone. Its artifacts remain in temporary directories for diagnosis.

Automated checks do not establish compatibility with every capture card, audio
device, display or GPU. Test those on the actual church computer, including a
restart and a longer recording. A build is ready to distribute only after its
native packaged smoke check succeeds. Signing and notarization are separate
release steps.

### Test current desktop source with existing runtimes

For a quick performance regression run, build the current source and supply an
already-installed or checksum-verified Electron runtime matching the exact
version in `desktop/package.json`:

```sh
npm run build
LUMEN_DESKTOP_OUTPUT_SECONDS=30 node desktop/scripts/smoke.mjs --source /absolute/path/to/Electron.app
```

`--source` clones `desktop/build/resources` into a temporary directory, verifies
that its backend lockfile matches the current checkout, and overlays the newly
built frontend, backend and shared modules. It rejects stale builds. It launches
the current `desktop/app` code with disposable stations; it does not patch an
installed app or use the operator's library. Existing native runtimes must
already be prepared for the current platform and architecture. No downloads or
native rebuilds occur in this mode.

The duration is per phase (12–300 seconds): output plus recording with the
operator visible, then with the operator minimized. The report identifies
`source` versus `packaged` mode and retains frame measurements and renderer
diagnostics. Source mode supports quick comparisons; validate the finished
package separately with the default packaged smoke command before distribution.

To qualify full-HD output on a target machine, add
`LUMEN_DESKTOP_OUTPUT_PROFILE=1080p30`. Each phase then requires at least 28
presented fps, 1920×1080 for at least 95% of the measured time, no frame gap of
250 ms or longer, and a 95th-percentile gap of at most 70 ms. The default
`continuity` profile remains the broader startup/recovery check described above.
Neither short profile replaces a service-length test with the actual displays,
capture devices and content.

### Local Mac update retention

Use `node desktop/scripts/update-mac.mjs /absolute/path/to/Lumen.app` for future
local updates. Quit Lumen first. The updater verifies signatures, stages an APFS
clone, and retains the previous app for rollback. It never writes to Application
Support, notes databases, media, recordings or training data.

Launch the installed app and check Studio and Notes. Once it works, run
`node desktop/scripts/update-mac.mjs --confirm-working`. This retains exactly
one recent working app backup and removes older timestamped app backups only.
A pending update blocks another installation until confirmed, preventing backup
accumulation. On a failed launch, restore the previous app; do not confirm it.
Station-data snapshots are deliberately outside app-retention cleanup.
