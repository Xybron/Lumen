// Native output-window regression, using a disposable station and no physical inputs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '../..');
const require = createRequire(path.join(root, 'backend/package.json'));
const { _electron } = require('playwright-core');
const appPath = path.resolve(process.argv[2] || 'desktop/dist-fullscreen-2026-11-18/Lumen.app');
const station = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-smoke-fullscreen-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(LUMEN_|VPS_|MEDIA_ENGINE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(key)));
env.LUMEN_DESKTOP_SMOKE_DIR = station;
let application; const checks = []; let log = '';
const report = { application: appPath, station, checks };
async function until(fn, message) { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error(message); }
try {
  application = await _electron.launch({ executablePath: path.join(appPath, 'Contents/MacOS/Lumen'), env, timeout: 90000 });
  application.process().stdout?.on('data', data => { log += data; }); application.process().stderr?.on('data', data => { log += data; });
  const page = await application.firstWindow();
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('admin');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Program links', exact: true }).click();
  await page.getByRole('tab', { name: 'Display', exact: true }).click();
  await page.getByRole('button', { name: /^(Find|Refresh) displays$/ }).click();
  const displays = await page.evaluate(() => window.lumenDisplays.list());
  assert.ok(displays.length); report.displays = displays;
  console.log('Native displays:', displays.map(d => d.label));
  const selected = displays.find(d => !d.isCurrent) || displays[0];
  await page.getByRole('dialog').getByRole('combobox').selectOption(selected.id);
  const popupPromise = application.waitForEvent('window');
  await page.getByRole('button', { name: 'Open output', exact: true }).click();
  let output = await popupPromise; await output.waitForURL('**/studio/output/program?display=1');
  let native = await application.browserWindow(output);
  console.log('Assigned output loaded; checking fullscreen');
  const full = () => native.evaluate(w => w.isSimpleFullScreen());
  await until(full, 'Assigned output did not enter native fullscreen');
  const bounds = await native.evaluate(w => w.getBounds());
  const expected = await application.evaluate(({ screen }, id) => screen.getAllDisplays().find(d => `desktop-${d.id}` === id).bounds, selected.id);
  assert.deepEqual(bounds, expected);
  const operator = await application.browserWindow(page);
  assert.equal(await operator.evaluate(w => w.isSimpleFullScreen() || w.isFullScreen()), false);
  checks.push('Assigned output fills the selected physical display; operator remains windowed');
  await output.keyboard.press('Escape'); await until(async () => !await full(), 'Escape did not exit fullscreen');
  await output.keyboard.press('f'); await until(full, 'F did not re-enter fullscreen');
  await output.getByRole('button', { name: 'Fullscreen', exact: true }).click({ force: true });
  await until(async () => !await full(), 'Fullscreen button did not exit native fullscreen');
  checks.push('Escape exits; F and the Fullscreen button toggle native fullscreen');
  await output.close();
  await page.reload(); await page.getByRole('button', { name: 'Program links', exact: true }).click();
  await page.getByRole('tab', { name: 'Display', exact: true }).click();
  const reopened = application.waitForEvent('window');
  // No Find displays call: opening resolves the persisted identity freshly.
  await page.getByRole('button', { name: 'Open output', exact: true }).click();
  output = await reopened; await output.waitForURL('**/studio/output/program?display=1'); native = await application.browserWindow(output);
  await until(full, 'Persisted assignment did not reopen fullscreen');
  assert.deepEqual(await native.evaluate(w => w.getBounds()), expected);
  checks.push('Saved assignment survives a reload and reopens fullscreen without rediscovery');
  await output.close();
  await page.getByRole('dialog').getByRole('combobox').selectOption('');
  const manual = application.waitForEvent('window');
  await page.getByRole('button', { name: 'Open output', exact: true }).click();
  output = await manual; await output.waitForURL('**/studio/output/program?display=1'); native = await application.browserWindow(output);
  assert.equal(await full(), false); checks.push('Manual window remains windowed');
  await output.close();
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) { report.ok = false; report.error = error.stack; throw error; }
finally {
  await application?.close();
  const artifacts = path.join(root, 'artifacts/desktop-fullscreen-2026-11-18'); await fs.mkdir(artifacts, { recursive: true });
  await fs.writeFile(path.join(artifacts, 'native-test.json'), JSON.stringify(report, null, 2));
  await fs.writeFile(path.join(artifacts, 'native-test.log'), log);
}
