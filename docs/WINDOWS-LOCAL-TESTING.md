# Test Lumen on the church Windows computer

For the Electron installer and its local Windows build steps, use the
[desktop setup guide](DESKTOP.md). The instructions below are for running the
web edition directly from source.

This runs Lumen from source on the computer connected to the cameras and
displays. Use Windows 10/11 with Git, Node.js 22 (including npm), and Google
Chrome installed. Node 22 matches the repository's build configuration.
Install dependencies on Windows; do not copy `node_modules` from a Mac.

The instructions below use the `codex/windows-church-test` branch. The GitHub
account used on Windows needs access to the private repository. A clone receives
the committed application code; local station files from the development Mac
are not part of this setup.

## First run

Open PowerShell in the folder where you want the source checkout, then run:

```powershell
git clone --branch codex/windows-church-test https://github.com/Xybron/Lumen.git
cd Lumen
npm.cmd run install:all
npm.cmd run build

$env:LUMEN_DATA_DIR = Join-Path $env:LOCALAPPDATA "Lumen\church-test"
npm.cmd start
```

Use `npm.cmd` in PowerShell so the commands do not depend on PowerShell allowing
the `npm.ps1` launcher. Wait for each install/build command to succeed before
continuing. The first installation needs internet access for packages and the
bundled FFmpeg binary; the core local app does not require a cloud account.

Open **http://127.0.0.1:3000/studio** in Chrome. Keep the PowerShell window open.
For this new station, sign in with **admin / admin** and change its password in
**Team & roles**. Click **Start engine** in Studio.

The data-folder setting creates a separate test station under
`%LOCALAPPDATA%\Lumen\church-test`, outside the Git checkout. It starts with
fresh accounts and content. The Mac's scenes, media, songs, accounts and
recordings are not transferred by these commands. Import the files you want to
rehearse with through Lumen.

## Bring your existing library from the Mac

On the Mac, open **profile image → Data settings → Export**, choose the Bibles,
songs, presentations, media, scenes or other content you want, and download the
`.lumen` file. Copy that file to the Windows laptop. In Windows Lumen, open
**profile image → Data settings → Import**, select the file, review its contents,
then choose **Import selected**. Accounts and camera device selections stay local;
select the Windows capture card again after importing.

## Camera and display check

1. Connect and power on the camera: camera HDMI → capture card → USB. Allow
   Chrome camera access when Lumen requests it. In Windows camera privacy
   settings, allow desktop apps to access the camera.
2. Add a Camera source, choose the capture card by name, and check its preview.
   Choose Resolution and Frame rate, or keep Auto. Select the card's audio input
   if you need HDMI audio. Device selections must be made again on this computer.
3. Reopen the source's Properties, change a format, preview it, then save.
4. Add an image/video and test playback, looping, and sound. New sources start
   muted; unmute the intended inputs in the audio mixer.
5. Open Live View, move it to the church display, and press F for fullscreen.
   Cut or Fade a prepared scene to Program and confirm the display and audio.
6. Make a short local recording and play it back. Restart Lumen and confirm that
   the station settings remain available; reconnect the camera source as needed.

Keep the operator's source-supplying tab open while using cameras and microphones.
Use the localhost address on this computer for capture permissions.

## Start again or update

Stop Lumen with **Ctrl+C** in PowerShell. For later starts, open PowerShell in
the same `Lumen` checkout and run:

```powershell
$env:LUMEN_DATA_DIR = Join-Path $env:LOCALAPPDATA "Lumen\church-test"
npm.cmd start
```

To install an updated revision, stop Lumen first, then run:

```powershell
git pull --ff-only
npm.cmd run install:all
npm.cmd run build
$env:LUMEN_DATA_DIR = Join-Path $env:LOCALAPPDATA "Lumen\church-test"
npm.cmd start
```

Back up the entire `church-test` data folder while Lumen is stopped. Do not run
two Lumen instances against the same data folder. Your test data remains outside
Git when pulling code updates.

## If setup fails

- **Chrome not found:** install Google Chrome. For a custom installation, set
  `$env:LUMEN_CHROME_PATH` to the full path of `chrome.exe` in the same PowerShell
  window before starting Lumen. Lumen checks Program Files, Program Files (x86),
  and the current user's Chrome installation.
- **Native dependency installation fails:** confirm `node --version` reports
  Node 22 and that Node matches the computer's architecture. Keep the first npm
  error for diagnosis; do not copy another computer's installed dependencies.
- **Camera missing:** check Windows Device Manager, the USB connection, and the
  capture-card driver. Refresh devices in Lumen. If another app is using the
  card, close it and retry the preview.
- **Engine or port already in use:** stop the other Lumen process first. Keep
  the complete startup error; do not delete a runtime lock while Lumen is running.

The Windows lease compatibility change is covered by simulated Windows metadata
tests on the development Mac. Actual Windows startup, capture hardware, displays
and long-running performance still need this on-machine rehearsal. Local AI
listening is optional and its Windows installer is not yet verified.
