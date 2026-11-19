'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DeviceTransport } = require('./virtual-device-transport.cjs');
const exec = promisify(execFile);

function canOperate(identity) {
  return !!identity?.user && (identity.user.isAdmin === true || !!identity.grants?.some(grant =>
    grant.channelId === '*' && ['author', 'owner'].includes(grant.role)));
}

function registerVirtualDevices({ app, BrowserWindow, ipcMain, shell, session, origin, trustedSender, log }) {
  const supported = ['darwin', 'win32'].includes(process.platform);
  const resources = app.isPackaged ? path.join(process.resourcesPath, 'virtual-devices') : path.join(__dirname, '../build/virtual-devices');
  const executable = process.platform === 'win32' ? path.join(resources, 'LumenDeviceBridge.exe')
    : app.isPackaged ? path.join(path.dirname(process.execPath), 'LumenDeviceBridge') : path.join(resources, 'LumenDeviceBridge');
  let window, transport, watchdog, operatorId, transitioning = false, generation = 0;
  let lastVideo = 0, lastAudio = 0, error = '', activationState = '';
  let probe, probeAt = 0, probeError = '', devices = { camera: false, microphone: false };
  async function authorize() {
    const response = await session.fetch(`${origin}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
    const identity = response.ok ? await response.json() : null;
    if (!canOperate(identity)) throw new Error('Sign in with Studio operator access to use Lumen devices.');
    return identity.user.id;
  }
  async function manifest() { try { return JSON.parse(await fs.readFile(path.join(resources, 'manifest.json'), 'utf8')); } catch { return null; } }
  async function status() {
    const build = supported ? await manifest() : null;
    if (build && !probe && Date.now() - probeAt >= 2500) {
      // Multiple Studio windows and a start request share a single native probe.
      // Initial CoreMediaIO discovery can take several seconds on a busy Mac.
      probe = (async () => {
        try {
          const result = await exec(executable, ['status'], { timeout: 10000, maxBuffer: 16384, windowsHide: true });
          const state = JSON.parse(result.stdout.trim());
          devices = { camera: state.camera === true, microphone: state.microphone === true };
          probeError = '';
        } catch (cause) {
          devices = { camera: false, microphone: false };
          probeError = cause.killed ? 'Device discovery timed out. Lumen will check again.' : `Could not read Lumen devices: ${cause.message}`;
          log(`[virtual-devices] Probe failed: ${cause.code || cause.signal || cause.message}\n`);
        } finally { probeAt = Date.now(); probe = null; }
      })();
    }
    if (probe) await probe;
    return { supported, platform: process.platform, built: !!build, signed: !!build?.signed, packaged: app.isPackaged,
      ...devices, running: !!transport && !transport.closed, busy: transitioning,
      receivingVideo: Date.now() - lastVideo < 1500, receivingAudio: Date.now() - lastAudio < 1500,
      activation: activationState, error: error || probeError };
  }
  function stop(reason = '') {
    generation++;
    clearInterval(watchdog); watchdog = null;
    const old = transport; transport = null; old?.close();
    const oldWindow = window; window = null; if (oldWindow && !oldWindow.isDestroyed()) oldWindow.destroy();
    lastVideo = 0; lastAudio = 0; operatorId = undefined;
    if (reason) { error = reason; log(`[virtual-devices] ${reason}\n`); }
  }
  async function start() {
    if (transport) return;
    const currentGeneration = ++generation;
    const id = await authorize();
    const state = await status();
    if (!state.signed || !app.isPackaged) throw new Error('Install a signed Lumen desktop build to enable the camera and microphone.');
    if (!state.camera || !state.microphone) throw new Error('Install and enable both Lumen devices, then restart apps that will use them.');
    const response = await session.fetch(`${origin}/api/studio/engine/start`, { method: 'POST', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Could not start Program.');
    if (generation !== currentGeneration) throw new Error('Lumen device startup was cancelled.');
    error = '';
    operatorId = id;
    const child = spawn(executable, ['stream'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.stderr.on('data', bytes => log(`[virtual-devices] ${bytes}`));
    const current = new DeviceTransport(child, cause => stop(cause.message));
    transport = current;
    await current.ready;
    if (transport !== current) throw new Error('Lumen device startup was cancelled.');
    window = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: {
      session, preload: path.join(__dirname, 'virtual-output-preload.cjs'), contextIsolation: true,
      sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    } });
    const contents = window.webContents;
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const allowed = `${origin}/studio/virtual-output`;
    contents.on('will-navigate', (event, url) => { if ((url ?? event.url) !== allowed) event.preventDefault(); });
    contents.on('will-redirect', event => event.preventDefault());
    contents.on('render-process-gone', () => stop('The Program receiver stopped. Start Lumen devices again.'));
    let checking = false;
    watchdog = setInterval(async () => {
      if (checking) return;
      checking = true;
      try { const id = await authorize(); if (generation === currentGeneration && id !== operatorId) stop('Lumen devices stopped because the operator signed out.'); }
      catch { if (generation === currentGeneration) stop('Lumen devices stopped because operator access could not be verified.'); }
      finally { checking = false; }
    }, 2000);
    await window.loadURL(allowed);
  }
  function validReceiver(event) {
    return window && event.sender === window.webContents && event.senderFrame === event.sender.mainFrame
      && event.senderFrame.url === `${origin}/studio/virtual-output`;
  }
  ipcMain.handle('lumen:devices:video', async (event, bytes) => {
    if (!validReceiver(event) || !transport) return false;
    const current = transport, accepted = await current.send(1, bytes);
    if (accepted && current === transport) lastVideo = Date.now();
    return accepted;
  });
  ipcMain.handle('lumen:devices:audio', async (event, bytes) => {
    if (!validReceiver(event) || !transport) return false;
    const current = transport, accepted = await current.send(2, bytes);
    if (accepted && current === transport) lastAudio = Date.now();
    return accepted;
  });
  ipcMain.on('lumen:devices:receiver-error', (event, message) => {
    if (validReceiver(event)) stop(typeof message === 'string' ? message.slice(0, 300) : 'Program capture failed.');
  });
  async function activate() {
    if (process.platform === 'win32') return installAudio();
    const build = await manifest();
    if (!build?.signed || !app.isPackaged) throw new Error('Camera activation requires a signed Lumen build installed in Applications.');
    if (['activating', 'approval-required'].includes(activationState)) return;
    activationState = 'activating'; error = '';
    // Run the request in the provisioned main app. A standalone helper cannot
    // claim the host's restricted system-extension.install entitlement.
    const activation = require(path.join(resources, 'LumenActivation.node'));
    activation.request('activate', message => {
      if (message.startsWith('error:')) { error = message.slice(6); activationState = 'failed'; }
      else activationState = message;
      probeAt = 0;
    });
  }
  async function installAudio() {
    if (!(await manifest())?.signed || !app.isPackaged) throw new Error('Device installation requires a signed Lumen desktop build.');
    const result = await shell.openPath(path.join(resources, process.platform === 'win32' ? 'LumenDevicesSetup.exe' : 'LumenAudio.pkg'));
    if (result) throw new Error(result);
    probeAt = 0;
  }
  ipcMain.handle('lumen:devices:control', async (event, command) => {
    if (!trustedSender(event) || !['status', 'start', 'stop', 'activate', 'install-audio'].includes(command)) throw new Error('Device request denied.');
    if (command === 'status') return status();
    await authorize();
    if (command === 'stop') { stop(); return status(); }
    if (transitioning) throw new Error('A device operation is already in progress.');
    transitioning = true;
    try {
      if (command === 'start') await start();
      if (command === 'activate') await activate();
      if (command === 'install-audio') await installAudio();
    } catch (cause) { error = cause.message; if (command === 'start') stop(); if (command === 'activate') activationState = 'failed'; throw cause; }
    finally { transitioning = false; }
    return status();
  });
  // Cookie removal is immediate; the watchdog also catches grant revocation and station loss.
  session.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed && cookie.name === 'lumen_session') stop('Lumen devices stopped because the operator signed out.');
  });
  return { stop, close: stop };
}
module.exports = { registerVirtualDevices, canOperate };
