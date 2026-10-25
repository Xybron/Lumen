'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, desktopCapturer, shell, session, systemPreferences, powerSaveBlocker } = require('electron');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { isLocalUrl, isExternalUrl, isPreviewUrl, canGrantPermission, childEnvironment, runtimePaths, availablePort } = require('./runtime.cjs');

app.setName('Lumen');
const smokeDirectory = process.env.LUMEN_DESKTOP_SMOKE_DIR;
if (smokeDirectory) {
  const canonical = syncFs.realpathSync(smokeDirectory);
  const temporary = syncFs.realpathSync(os.tmpdir());
  if (!path.isAbsolute(smokeDirectory) || !canonical.startsWith(temporary + path.sep) || !path.basename(canonical).startsWith('lumen-desktop-smoke-')) {
    throw new Error('Desktop smoke tests require their own lumen-desktop-smoke-* temporary directory.');
  }
  syncFs.mkdirSync(path.join(canonical, 'app'), { recursive: true });
  app.setPath('userData', path.join(canonical, 'app'));
  // Smoke tests must never open the operator's camera or microphone.
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('mute-audio');
}

let backend;
let mainWindow;
let origin;
let quitting = false;
let quitRequested = false;
let pickerState;
let sleepBlocker;
let logFile;
const desktopSessionName = 'persist:lumen-desktop';
const webPreferences = () => ({
  nodeIntegration: false, nodeIntegrationInWorker: false, contextIsolation: true,
  sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
  webviewTag: false, backgroundThrottling: false,
  partition: desktopSessionName, preload: path.join(__dirname, 'preload.cjs'),
});

function log(value) {
  const text = String(value);
  if (logFile) void fs.appendFile(logFile, text).catch(() => {});
  if (smokeDirectory) process.stdout.write(text);
}

async function stopBackend() {
  if (!backend || backend.exitCode !== null || backend.signalCode !== null) return;
  const child = backend;
  await new Promise(resolve => {
    const timeout = setTimeout(() => { child.kill(); resolve(); }, 22000);
    child.once('exit', () => { clearTimeout(timeout); resolve(); });
    if (child.connected) child.send({ type: 'shutdown' }); else child.kill();
  });
}

async function quit() {
  if (quitRequested || quitting) return;
  quitRequested = true;
  try {
    if (!smokeDirectory && backend && origin) {
      let active = true;
      try {
        const status = await (await fetch(`${origin}/api/studio/status`, { signal: AbortSignal.timeout(1500) })).json();
        active = status.state === 'running' || status.state === 'starting' || !!status.recording;
      } catch { /* Ask before closing a station whose state cannot be read. */ }
      if (active) {
        const answer = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
          type: 'question', title: 'Quit Lumen?', message: 'Quit Lumen and stop its outputs?',
          detail: 'Stop any recording in Studio first so it can finish saving.',
          buttons: ['Keep Lumen open', 'Quit Lumen'], defaultId: 0, cancelId: 0,
        });
        if (answer.response !== 1) return;
      }
    }
    quitting = true;
    pickerState?.finish(null);
    await stopBackend();
    if (sleepBlocker !== undefined) powerSaveBlocker.stop(sleepBlocker);
    app.quit();
  } finally { quitRequested = false; }
}

function attachWindow(window, { primary = false, preview = false } = {}) {
  const contents = window.webContents;
  const permitted = url => isLocalUrl(url, origin) || preview && isPreviewUrl(url, origin);
  contents.on('will-navigate', (event, url) => { if (!permitted(url ?? event.url)) event.preventDefault(); });
  contents.on('will-redirect', (event, url) => { if (!permitted(url ?? event.url)) event.preventDefault(); });
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (!isLocalUrl(contents.getURL(), origin) || !(isLocalUrl(url, origin) || isPreviewUrl(url, origin))) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: {
      title: 'Lumen', width: 1280, height: 800, backgroundColor: '#101113', autoHideMenuBar: true,
      webPreferences: webPreferences(),
    } };
  });
  contents.on('did-create-window', (child, details) => attachWindow(child, { preview: isPreviewUrl(details.url, origin) }));
  contents.on('render-process-gone', (_event, details) => log(`[desktop] Window renderer stopped: ${details.reason}\n`));
  if (primary) window.on('close', event => { if (!quitting) { event.preventDefault(); void quit(); } });
}

function trustedSender(event) {
  return event.senderFrame && event.senderFrame === event.sender.mainFrame && isLocalUrl(event.senderFrame.url, origin);
}

function configurePermissions(desktopSession) {
  desktopSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    !!contents && canGrantPermission(permission, details.requestingUrl || requestingOrigin, contents.getURL(), origin));
  desktopSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!canGrantPermission(permission, details.requestingUrl, contents.getURL(), origin)) return callback(false);
    if (permission !== 'media' || process.platform !== 'darwin' || smokeDirectory) return callback(true);
    const kinds = (details.mediaTypes || []).filter(kind => kind === 'audio' || kind === 'video');
    void Promise.all(kinds.map(kind => systemPreferences.askForMediaAccess(kind === 'video' ? 'camera' : 'microphone')))
      .then(results => callback(results.every(Boolean)), () => callback(false));
  });
  desktopSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!request.userGesture || !request.videoRequested || !request.frame || request.frame !== request.frame.top
      || !isLocalUrl(request.frame.url, origin) || !isLocalUrl(request.securityOrigin, origin) || pickerState) {
      callback(null); return;
    }
    void chooseDisplay(request).then(choice => {
      try {
        if (!request.frame || request.frame !== request.frame.top || !isLocalUrl(request.frame.url, origin)) callback(null);
        else callback(choice);
      } catch { /* Chromium discards a request after its frame closes. */ }
    }, () => { try { callback(null); } catch {} });
  });
  desktopSession.on('will-download', (_event, item) => {
    if (!smokeDirectory) return;
    const directory = path.join(smokeDirectory, 'downloads'); syncFs.mkdirSync(directory, { recursive: true });
    item.setSavePath(path.join(directory, `${Date.now()}-${path.basename(item.getFilename()).replace(/[<>:"/\\|?*]/g, '_')}`));
  });
}

async function chooseDisplay(request) {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 440, height: 260 }, fetchWindowIcons: false });
  if (!sources.length || pickerState || quitting) return null;
  const parent = BrowserWindow.getAllWindows().find(window => window.webContents.mainFrame === request.frame.top) || mainWindow;
  const picker = new BrowserWindow({
    width: 680, height: 600, minWidth: 520, minHeight: 400, title: 'Share a screen or window',
    parent, modal: true, show: false, backgroundColor: '#17181a', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, preload: path.join(__dirname, 'picker-preload.cjs'), partition: 'lumen-picker' },
  });
  picker.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  picker.webContents.on('will-navigate', event => event.preventDefault());
  const pickerSession = picker.webContents.session;
  pickerSession.setPermissionRequestHandler((_contents, _permission, done) => done(false));
  pickerSession.setPermissionCheckHandler(() => false);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = value => {
      if (settled) return; settled = true;
      pickerState = undefined; resolve(value);
      if (!picker.isDestroyed()) picker.destroy();
    };
    pickerState = { picker, sources, audio: request.audioRequested && process.platform === 'win32', finish };
    picker.on('closed', () => finish(null));
    picker.once('ready-to-show', () => picker.show());
    void picker.loadFile(path.join(__dirname, 'picker.html')).catch(error => { finish(null); reject(error); });
  });
}

function validPicker(event) {
  return pickerState && !pickerState.picker.isDestroyed() && event.sender === pickerState.picker.webContents
    && event.senderFrame === event.sender.mainFrame
    && event.senderFrame.url === pathToFileURL(path.join(__dirname, 'picker.html')).href;
}

ipcMain.handle('lumen:picker:sources', event => {
  if (!validPicker(event)) throw new Error('The screen picker is no longer active.');
  return { audio: pickerState.audio, sources: pickerState.sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) };
});
ipcMain.on('lumen:picker:choose', (event, value) => {
  if (!validPicker(event)) return;
  const source = pickerState.sources.find(item => item.id === value?.id);
  if (!source) return;
  pickerState.finish({ video: source, ...(pickerState.audio && value.audio === true ? { audio: 'loopback' } : {}) });
});
ipcMain.on('lumen:picker:cancel', event => { if (validPicker(event)) pickerState.finish(null); });
ipcMain.on('lumen:open-external', (event, url) => {
  if (trustedSender(event) && isExternalUrl(url) && !isLocalUrl(url, origin)) void shell.openExternal(url).catch(error => log(`[desktop] Cannot open link: ${error.message}\n`));
});

async function launchBackend(runtime, port, stationDirectory) {
  const bootstrap = app.isPackaged ? path.join(process.resourcesPath, 'backend.cjs') : path.join(__dirname, 'backend.cjs');
  const env = childEnvironment(process.env, {
    LUMEN_DESKTOP_RUNTIME_ROOT: runtime.root,
    LUMEN_DATA_DIR: stationDirectory, LUMEN_CHROME_PATH: runtime.chromium,
    LUMEN_WHISPER_SERVER: runtime.whisper, LUMEN_DESKTOP_MODEL: runtime.model,
    PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production',
  });
  const child = spawn(runtime.node, [bootstrap], { env, cwd: path.join(runtime.root, 'lumen'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  backend = child;
  child.stdout.on('data', log); child.stderr.on('data', log);
  return new Promise((resolve, reject) => {
    let ready = false;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Lumen took too long to start. See desktop.log in the application data folder.')); }, 60000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (!ready) reject(new Error(`Lumen's backend stopped before startup (${signal || code}).`));
      else if (!quitting) {
        log(`[desktop] Backend exited (${signal || code}).\n`);
        if (!smokeDirectory) dialog.showErrorBox('Lumen stopped', 'The local station stopped unexpectedly. Close and reopen Lumen. Your saved library is retained.');
        quitting = true; app.exit(1);
      }
    });
    child.on('message', message => {
      if (message?.type === 'ready' && message.port === port) { ready = true; clearTimeout(timeout); resolve(); }
      if (message?.type === 'error') { clearTimeout(timeout); const error = new Error(message.message || 'Lumen could not start.'); error.code = message.code; reject(error); }
    });
  });
}

async function start() {
  const root = app.isPackaged ? process.resourcesPath : process.env.LUMEN_DESKTOP_RESOURCES || path.resolve(__dirname, '..', 'build', 'resources');
  const runtime = await runtimePaths(root);
  const userDirectory = app.getPath('userData');
  const stationDirectory = smokeDirectory ? path.join(smokeDirectory, 'station') : path.join(userDirectory, 'station');
  await fs.mkdir(userDirectory, { recursive: true });
  logFile = path.join(userDirectory, 'desktop.log');
  try { if ((await fs.stat(logFile)).size > 2 * 1024 * 1024) await fs.rename(logFile, logFile + '.previous'); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
  const settingsFile = path.join(userDirectory, 'desktop.json');
  let preferredPort = 43117;
  try { const saved = JSON.parse(await fs.readFile(settingsFile, 'utf8')); if (Number.isInteger(saved.port) && saved.port > 1024 && saved.port <= 65535) preferredPort = saved.port; } catch {}
  let port;
  for (let attempt = 0; attempt < 3; attempt++) {
    port = await availablePort(attempt ? 0 : preferredPort);
    try { await launchBackend(runtime, port, stationDirectory); break; }
    catch (error) { await stopBackend(); if (error.code !== 'EADDRINUSE' || attempt === 2) throw error; }
  }
  origin = `http://127.0.0.1:${port}`;
  await fs.writeFile(settingsFile, JSON.stringify({ port }) + '\n');
  configurePermissions(session.fromPartition(desktopSessionName));
  sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
  mainWindow = new BrowserWindow({ title: 'Lumen', width: 1440, height: 960, minWidth: 1000, minHeight: 680, show: false, backgroundColor: '#101113', webPreferences: webPreferences() });
  attachWindow(mainWindow, { primary: true });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  const template = [
    ...(process.platform === 'darwin' ? [{ label: 'Lumen', submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Quit Lumen', accelerator: 'Cmd+Q', click: () => void quit() }] }] : []),
    { label: 'File', submenu: [{ label: 'Open data folder', click: () => void shell.openPath(stationDirectory) }, { type: 'separator' }, { label: 'Quit Lumen', accelerator: process.platform === 'darwin' ? undefined : 'Ctrl+Q', click: () => void quit() }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  await mainWindow.loadURL(`${origin}/studio`);
  log(`[desktop] Lumen ready at ${origin}; station ${stationDirectory}\n`);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => { if (!quitting) void quit(); });
  app.on('activate', () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show(); });
  void app.whenReady().then(start).catch(async error => {
    log(`[desktop] ${error.stack || error.message}\n`);
    await stopBackend();
    if (!smokeDirectory) dialog.showErrorBox('Lumen could not start', error.message);
    quitting = true; app.exit(1);
  });
}
