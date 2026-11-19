'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async context => {
  if (!['darwin', 'win32'].includes(context.electronPlatformName)) return;
  const { Arch } = require('builder-util');
  const native = path.join(__dirname, '../build/virtual-devices');
  const manifest = JSON.parse(await fs.readFile(path.join(native, 'manifest.json'), 'utf8'));
  if (manifest.platform !== context.electronPlatformName || manifest.arch !== Arch[context.arch])
    throw new Error('Rebuild virtual devices for this operating system and architecture before packaging.');
  if (context.electronPlatformName === 'win32') {
    if (process.env.CSC_LINK && !manifest.signed) throw new Error('A signed Windows release requires signed virtual-device components.');
    const resources = path.join(context.appOutDir, 'resources/virtual-devices');
    await fs.mkdir(resources, { recursive: true });
    for (const file of ['manifest.json', 'LumenDeviceBridge.exe', 'LumenCamera.dll', 'LumenDevicesSetup.exe', 'SOFTCAM-LICENSE.txt', 'AUDIO-DRIVER-LICENSE.txt'])
      await fs.copyFile(path.join(native, file), path.join(resources, file));
    return;
  }
  if (!!process.env.CSC_NAME !== manifest.signed && process.env.CSC_NAME !== '-')
    throw new Error('The virtual devices and Lumen app must use the same signing configuration.');
  if (manifest.signed && manifest.team !== process.env.LUMEN_APPLE_TEAM_ID)
    throw new Error('The virtual devices and Lumen app must use the same Apple team.');
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app/Contents`);
  const extensions = path.join(contents, 'Library/SystemExtensions');
  const resources = path.join(contents, 'Resources/virtual-devices');
  await fs.mkdir(extensions, { recursive: true });
  await fs.mkdir(resources, { recursive: true });
  await fs.cp(path.join(native, 'app.lumen.studio.camera.systemextension'), path.join(extensions, 'app.lumen.studio.camera.systemextension'), { recursive: true });
  await fs.copyFile(path.join(native, 'LumenDeviceBridge'), path.join(contents, 'MacOS/LumenDeviceBridge'));
  await fs.chmod(path.join(contents, 'MacOS/LumenDeviceBridge'), 0o755);
  if (manifest.signed) await fs.copyFile(path.join(native, 'host.provisionprofile'), path.join(contents, 'embedded.provisionprofile'));
  for (const file of ['manifest.json', 'LumenAudio.pkg', 'LumenActivation.node']) await fs.copyFile(path.join(native, file), path.join(resources, file));
  const license = path.join(__dirname, '../native/macos/vendor/node-api');
  await fs.copyFile(path.join(license, 'LICENSE'), path.join(resources, 'NODE-API-LICENSE.txt'));
};
