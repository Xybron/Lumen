import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const { _electron } = require('playwright-core');
const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-smoke-')));
const executablePath = process.platform === 'win32' ? path.join(root, 'desktop/dist/win-unpacked/Lumen.exe')
  : path.join(root, `desktop/dist/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Lumen.app/Contents/MacOS/Lumen`);
let app, log = '';
try {
  app = await _electron.launch({ executablePath, env: { ...process.env, LUMEN_DESKTOP_SMOKE_DIR: directory }, timeout: 60000 });
  app.process().stdout.on('data', b => { log += b; }); app.process().stderr.on('data', b => { log += b; });
  const page = await app.firstWindow();
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Production Studio', exact: true }).waitFor();
  const status = await page.evaluate(() => window.lumenVirtualDevices.status());
  assert.equal(status.packaged, true); assert.equal(status.built, true); assert.equal(status.supported, true);
  assert.equal(status.running, false); assert.equal(status.error, '');
  const panel = page.getByLabel('Lumen camera and microphone', { exact: true });
  await panel.scrollIntoViewIfNeeded(); await panel.waitFor();
  if (!status.signed) {
    assert.match(await panel.textContent(), /signed Lumen desktop release/);
    const failure = await page.evaluate(() => window.lumenVirtualDevices.start().then(() => '', error => error.message));
    assert.match(failure, /signed Lumen desktop build/);
    assert.equal((await page.evaluate(() => window.lumenVirtualDevices.status())).running, false);
  }
  if (process.platform === 'darwin') {
    const native = await app.evaluate(async ({ app }) => {
    const require = process.getBuiltinModule('node:module').createRequire(`${app.getAppPath()}/package.json`);
    const path = require('node:path');
    const addon = require(path.join(process.resourcesPath, 'virtual-devices/LumenActivation.node'));
    return typeof addon.request;
  });
    assert.equal(native, 'function', 'stable native activation addon loads in packaged Electron');
  }
  await page.screenshot({ path: path.join(directory, 'virtual-devices.png'), fullPage: true });
  console.log(JSON.stringify({ status, screenshot: path.join(directory, 'virtual-devices.png') }));
  console.log('PASS: packaged desktop starts, native status/control IPC works, and unsigned activation stays disabled.');
} catch (error) { console.error(log.slice(-6000)); throw error; }
finally { await app?.close(); }
