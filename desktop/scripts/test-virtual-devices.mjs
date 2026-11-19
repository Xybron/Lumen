import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['--test', path.join(desktop, 'test/virtual-devices.test.cjs')], { stdio: 'inherit' });
if (process.platform === 'darwin') {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-devices-test-'));
  try {
    const binary = path.join(temp, 'audio-ring-test');
    execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', path.join(desktop, 'native/macos/test/AudioRingTest.cpp'), '-o', binary], { stdio: 'inherit' });
    execFileSync(binary, [], { stdio: 'inherit' });
    const windowsRing = path.join(temp, 'windows-loopback-test');
    execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', path.join(desktop, 'native/windows/test/LoopbackTest.cpp'), '-o', windowsRing], { stdio: 'inherit' });
    execFileSync(windowsRing, [], { stdio: 'inherit' });
    const native = path.join(desktop, 'build/virtual-devices');
    const driverTest = path.join(temp, 'audio-driver-test');
    execFileSync('xcrun', ['clang++', '-std=c++17', '-O2', path.join(desktop, 'native/macos/test/AudioDriverTest.cpp'),
      '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', driverTest], { stdio: 'inherit' });
    execFileSync(driverTest, [path.join(native, 'audio-root/LumenAudio.driver/Contents/MacOS/LumenAudio')], { stdio: 'inherit' });
    const addon = require(path.join(native, 'LumenActivation.node'));
    assert.equal(typeof addon.request, 'function');
    assert.throws(() => addon.request('invalid', () => {}), /Invalid camera operation/);
    const status = JSON.parse(execFileSync(path.join(native, 'LumenDeviceBridge'), ['status'], { encoding: 'utf8', timeout: 10000 }));
    assert.equal(typeof status.camera, 'boolean'); assert.equal(typeof status.microphone, 'boolean');
    for (const artifact of ['LumenDeviceBridge', 'LumenActivation.node', 'app.lumen.studio.camera.systemextension', 'audio-root/LumenAudio.driver'])
      execFileSync('codesign', ['--verify', '--strict', path.join(native, artifact)], { stdio: 'inherit' });
    console.log('Native API, device enumeration and build signatures checked. No driver was installed or activated.');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
if (process.platform === 'win32') {
  execFileSync('ctest', ['--test-dir', path.join(desktop, 'build/windows-devices/camera'), '-C', 'Release', '--output-on-failure'], { stdio: 'inherit' });
  const status = JSON.parse(execFileSync(path.join(desktop, 'build/virtual-devices/LumenDeviceBridge.exe'), ['status'], { encoding: 'utf8', timeout: 10000 }));
  assert.equal(typeof status.camera, 'boolean'); assert.equal(typeof status.microphone, 'boolean');
  console.log('Windows native tests and device enumeration checked. No devices were installed.');
}
