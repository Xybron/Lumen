import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(desktop, 'native/windows');
const build = path.join(desktop, 'build/windows-devices');
const output = path.join(desktop, 'build/virtual-devices');
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, ...options });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
async function files(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file)); else result.push(file);
  }
  return result;
}
export async function prepareWindowsVirtualDevices() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build Windows devices on an x64 Windows PC using Visual Studio and the WDK.');
  const cert = process.env.LUMEN_WINDOWS_CERT_SHA1;
  const signedDriver = process.env.LUMEN_WINDOWS_SIGNED_DRIVER;
  if (!!cert !== !!signedDriver) throw new Error('Release devices need both LUMEN_WINDOWS_CERT_SHA1 and LUMEN_WINDOWS_SIGNED_DRIVER.');
  await fs.mkdir(build, { recursive: true });
  await fs.mkdir(output, { recursive: true });
  await fs.rm(path.join(output, 'manifest.json'), { force: true });
  // Always build the source before accepting a signed release package.
  await run('cmake', ['-S', source, '-B', path.join(build, 'camera'), '-A', 'x64']);
  await run('cmake', ['--build', path.join(build, 'camera'), '--config', 'Release']);
  await run('ctest', ['--test-dir', path.join(build, 'camera'), '-C', 'Release', '--output-on-failure']);
  const driverBuild = path.join(build, 'driver');
  await fs.mkdir(driverBuild, { recursive: true });
  await run('MSBuild.exe', [path.join(source, 'vendor/simple-audio/SimpleAudioSample.sln'), '/m', '/t:Build',
    '/p:Configuration=Release', '/p:Platform=x64', '/p:SignMode=Off', '/p:KMDF_VERSION_MAJOR=1', '/p:KMDF_VERSION_MINOR=31',
    `/p:OutDir=${driverBuild}${path.sep}`, `/p:LumenBuildRoot=${build}`]);
  for (const file of ['LumenCamera.dll', 'LumenDeviceBridge.exe'])
    await fs.copyFile(path.join(build, 'camera/Release', file), path.join(output, file));
  for (const [from, to] of [['softcam', 'SOFTCAM-LICENSE.txt'], ['simple-audio', 'AUDIO-DRIVER-LICENSE.txt']])
    await fs.copyFile(path.join(source, 'vendor', from, 'LICENSE'), path.join(output, to));

  // The OS driver signature must come from Microsoft's hardware signing flow.
  // A local Authenticode certificate cannot make an unsigned kernel driver usable.
  const candidates = await files(signedDriver ? path.resolve(signedDriver) : driverBuild);
  for (const extension of ['inf', 'sys', 'cat']) {
    const matches = candidates.filter(file => path.basename(file).toLowerCase() === `lumenaudio.${extension}`);
    if (!matches.length) throw new Error(`Expected LumenAudio.${extension} in ${signedDriver ? 'signed driver package' : 'WDK build output'}.`);
    const first = await fs.readFile(matches[0]);
    for (const duplicate of matches.slice(1)) if (!first.equals(await fs.readFile(duplicate)))
      throw new Error(`Conflicting LumenAudio.${extension} files in the driver output.`);
    await fs.copyFile(matches[0], path.join(output, `LumenAudio.${extension}`));
  }
  if (cert) {
    await run('signtool.exe', ['verify', '/kp', '/c', path.join(output, 'LumenAudio.cat'), path.join(output, 'LumenAudio.sys')]);
    await run('signtool.exe', ['verify', '/kp', '/c', path.join(output, 'LumenAudio.cat'), path.join(output, 'LumenAudio.inf')]);
    for (const file of ['LumenCamera.dll', 'LumenDeviceBridge.exe']) await sign(file);
  }
  const makensis = process.env.LUMEN_MAKENSIS || 'makensis.exe';
  await run(makensis, [`/DARTIFACTS=${output}`, path.join(source, 'Devices.nsi')]);
  if (cert) await sign('LumenDevicesSetup.exe');
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'win32', arch: 'x64',
    signed: !!cert, camera: 'Lumen Camera', microphone: 'Lumen Microphone', width: 1280, height: 720, fps: 30, sampleRate: 48000,
    minimumWindowsBuild: 19041 }, null, 2) + '\n');
  async function sign(file) {
    await run('signtool.exe', ['sign', '/sha1', cert, '/fd', 'SHA256', '/tr', process.env.LUMEN_WINDOWS_TIMESTAMP_URL || 'https://timestamp.digicert.com',
      '/td', 'SHA256', path.join(output, file)]);
    await run('signtool.exe', ['verify', '/pa', path.join(output, file)]);
  }
  console.log(`Built Windows Lumen devices (${cert ? 'signed release components' : 'development only; driver signing is required'}).`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareWindowsVirtualDevices();
