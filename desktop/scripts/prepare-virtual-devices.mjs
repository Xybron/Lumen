import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(desktop, 'native/macos');
const output = path.join(desktop, 'build/virtual-devices');
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}
function xml(value) { return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
function plistValue(value) {
  if (typeof value === 'boolean') return `<${value ? 'true' : 'false'}/>`;
  if (Array.isArray(value)) return `<array>${value.map(plistValue).join('')}</array>`;
  if (typeof value === 'object') return `<dict>${Object.entries(value).map(([key, v]) => `<key>${xml(key)}</key>${plistValue(v)}`).join('')}</dict>`;
  return `<string>${xml(value)}</string>`;
}
async function plist(file, value) {
  await fs.writeFile(file, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${plistValue(value)}</plist>\n`);
}
function validateProfile(file, team, bundle, install = false) {
  if (!file) throw new Error(`Provide a Developer ID provisioning profile for ${bundle}.`);
  const decoded = execFileSync('security', ['cms', '-D', '-i', file], { maxBuffer: 2 * 1024 * 1024 });
  const extract = key => execFileSync('plutil', ['-extract', key, key === 'Entitlements' ? 'json' : 'raw', '-o', '-', '-'], { input: decoded, encoding: 'utf8' }).trim();
  const entitlements = JSON.parse(extract('Entitlements'));
  if (entitlements['com.apple.application-identifier'] !== `${team}.${bundle}` ||
      entitlements['com.apple.developer.team-identifier'] !== team ||
      (install && entitlements['com.apple.developer.system-extension.install'] !== true) ||
      !(Date.parse(extract('ExpirationDate')) > Date.now())) {
    throw new Error(`The provisioning profile for ${bundle} must be unexpired and authorize this team, bundle and required capabilities.`);
  }
}

export async function prepareVirtualDevices() {
  if (process.platform === 'win32') {
    const { prepareWindowsVirtualDevices } = await import('./prepare-virtual-devices-windows.mjs');
    return prepareWindowsVirtualDevices();
  }
  if (process.platform !== 'darwin') return;
  const arch = process.env.LUMEN_NATIVE_ARCH || process.arch;
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported native architecture: ${arch}`);
  const target = arch === 'x64' ? 'x86_64' : 'arm64';
  const team = process.env.LUMEN_APPLE_TEAM_ID || '';
  const identity = process.env.CSC_NAME || '-';
  const installerIdentity = process.env.LUMEN_INSTALLER_IDENTITY;
  const signed = identity !== '-';
  if (signed && (!/^[A-Z0-9]{10}$/.test(team) || !installerIdentity)) {
    throw new Error('Signed virtual devices require LUMEN_APPLE_TEAM_ID and LUMEN_INSTALLER_IDENTITY (Developer ID Installer).');
  }
  if (signed) {
    validateProfile(process.env.LUMEN_HOST_PROFILE, team, 'app.lumen.studio', true);
    validateProfile(process.env.LUMEN_CAMERA_PROFILE, team, 'app.lumen.studio.camera');
  }
  await fs.rm(output, { recursive: true, force: true });
  const camera = path.join(output, 'app.lumen.studio.camera.systemextension');
  const driverRoot = path.join(output, 'audio-root');
  const driver = path.join(driverRoot, 'LumenAudio.driver');
  for (const bundle of [camera, driver]) await fs.mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  const baseInfo = { CFBundleInfoDictionaryVersion: '6.0', CFBundleVersion: '1', CFBundleShortVersionString: '1.0.0',
    CFBundleSupportedPlatforms: ['MacOSX'], LSMinimumSystemVersion: '13.0' };
  await plist(path.join(camera, 'Contents/Info.plist'), { ...baseInfo,
    CFBundleIdentifier: 'app.lumen.studio.camera', CFBundleExecutable: 'LumenCamera', CFBundleName: 'Lumen Camera',
    CFBundlePackageType: 'SYSX', LumenTeamIdentifier: team,
    NSSystemExtensionUsageDescription: 'Send Lumen’s Program picture to apps that use a camera.',
    CMIOExtension: { CMIOExtensionMachServiceName: `${team || 'UNSIGNED'}.app.lumen.studio.camera` } });
  await plist(path.join(driver, 'Contents/Info.plist'), { ...baseInfo,
    CFBundleIdentifier: 'app.lumen.studio.audio', CFBundleExecutable: 'LumenAudio', CFBundleName: 'Lumen Microphone',
    CFBundlePackageType: 'BNDL', CFPlugInFactories: { 'B6DF931E-A818-4A4F-9FE1-016F60E2D83A': 'LumenAudioFactory' },
    CFPlugInTypes: { '443ABAB8-E7B3-491A-B985-BEB9187030DB': ['B6DF931E-A818-4A4F-9FE1-016F60E2D83A'] },
    AudioServerPlugIn_MachServices: [], sandboxSafe: true });
  const cameraEntitlements = path.join(output, 'camera.entitlements');
  await plist(cameraEntitlements, { 'com.apple.security.app-sandbox': true,
    'com.apple.security.application-groups': [`${team || 'UNSIGNED'}.app.lumen.studio.camera`],
    ...(signed ? { 'com.apple.application-identifier': `${team}.app.lumen.studio.camera`, 'com.apple.developer.team-identifier': team } : {}) });
  if (signed) {
    await fs.copyFile(process.env.LUMEN_CAMERA_PROFILE, path.join(camera, 'Contents/embedded.provisionprofile'));
    await fs.copyFile(process.env.LUMEN_HOST_PROFILE, path.join(output, 'host.provisionprofile'));
    await plist(path.join(output, 'host.entitlements'), { 'com.apple.developer.system-extension.install': true,
      'com.apple.security.cs.allow-jit': true, 'com.apple.application-identifier': `${team}.app.lumen.studio`,
      'com.apple.developer.team-identifier': team });
  }
  const common = ['-target', `${target}-apple-macos13.0`, '-O2'];
  const nativeBridge = path.join(output, 'LumenDeviceBridge');
  await run('xcrun', ['clang++', ...common, '-std=c++17', '-fobjc-arc', '-Wno-deprecated-declarations',
    path.join(source, 'Bridge.mm'), '-framework', 'Foundation',
    '-framework', 'CoreMediaIO', '-framework', 'CoreMedia', '-framework', 'CoreVideo', '-framework', 'AudioToolbox',
    '-framework', 'CoreAudio', '-o', nativeBridge]);
  const activation = path.join(output, 'LumenActivation.node');
  await run('xcrun', ['clang++', ...common, '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup',
    '-DNAPI_VERSION=8', '-I', path.join(source, 'vendor/node-api'), path.join(source, 'Activation.mm'),
    '-framework', 'Foundation', '-framework', 'SystemExtensions', '-o', activation]);
  await run('xcrun', ['swiftc', '-target', `${target}-apple-macos13.0`, '-module-cache-path', path.join(output, 'swift-cache'), '-O',
    path.join(source, 'CameraExtension.swift'), path.join(source, 'main.swift'), '-framework', 'CoreMediaIO', '-framework', 'IOKit',
    '-o', path.join(camera, 'Contents/MacOS/LumenCamera')]);
  const aspl = path.join(source, 'vendor/libASPL');
  const sources = (await fs.readdir(path.join(aspl, 'src'))).filter(file => file.endsWith('.cpp')).map(file => path.join(aspl, 'src', file));
  await run('xcrun', ['clang++', ...common, '-std=c++17', '-bundle', '-fvisibility=hidden', '-I', path.join(aspl, 'include'),
    '-Wno-deprecated-declarations', '-Wno-invalid-offsetof', ...sources, path.join(source, 'AudioDriver.cpp'),
    '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-o', path.join(driver, 'Contents/MacOS/LumenAudio')]);
  await fs.mkdir(path.join(driver, 'Contents/Resources'), { recursive: true });
  for (const file of ['LICENSE', 'LICENSE.apple2012', 'LICENSE.apple2020', 'PROVENANCE.md'])
    await fs.copyFile(path.join(aspl, file), path.join(driver, 'Contents/Resources', file));
  const sign = async (file, identifier, entitlements) => run('codesign', ['--force', '--sign', identity,
    '--identifier', identifier, ...(signed ? ['--options', 'runtime', '--timestamp'] : []),
    ...(entitlements ? ['--entitlements', entitlements] : []), file]);
  await sign(nativeBridge, 'app.lumen.studio.device-bridge');
  await sign(activation, 'app.lumen.studio.activation');
  await sign(camera, 'app.lumen.studio.camera', cameraEntitlements);
  await sign(driver, 'app.lumen.studio.audio');
  const components = path.join(output, 'audio-components.plist');
  await plist(components, [{ RootRelativeBundlePath: 'LumenAudio.driver', BundleIsRelocatable: false,
    BundleHasStrictIdentifier: true, BundleOverwriteAction: 'upgrade' }]);
  await run('pkgbuild', ['--root', driverRoot, '--identifier', 'app.lumen.studio.audio.installer', '--version', '1.0.0',
    '--install-location', '/Library/Audio/Plug-Ins/HAL', '--ownership', 'recommended', '--component-plist', components,
    ...(installerIdentity ? ['--sign', installerIdentity] : []), path.join(output, 'LumenAudio.pkg')]);
  if (signed && process.env.LUMEN_NOTARY_PROFILE) {
    await run('xcrun', ['notarytool', 'submit', path.join(output, 'LumenAudio.pkg'), '--keychain-profile', process.env.LUMEN_NOTARY_PROFILE, '--wait']);
    await run('xcrun', ['stapler', 'staple', path.join(output, 'LumenAudio.pkg')]);
  }
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: 'darwin', arch,
    signed, team, camera: 'Lumen Camera', microphone: 'Lumen Microphone', width: 1280, height: 720, fps: 30, sampleRate: 48000 }, null, 2) + '\n');
  console.log(`Built Lumen virtual devices (${arch}, ${signed ? 'signed' : 'development only — activation requires signing'}).`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareVirtualDevices();
