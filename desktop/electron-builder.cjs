const path = require('node:path');

module.exports = {
  appId: 'app.lumen.studio',
  productName: 'Lumen',
  directories: { output: 'dist', buildResources: 'build' },
  files: ['app/**/*.cjs', 'app/**/*.js', 'app/**/*.html', 'app/**/*.css', 'package.json'],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  afterPack: require('./scripts/bundle-virtual-devices.cjs'),
  extraResources: [
    { from: 'build/resources', to: '.', filter: ['**/*'] },
    { from: 'app/backend.cjs', to: 'backend.cjs' },
  ],
  // Never silently build a package around another operating system's native
  // SQLite, Sharp, FFmpeg or browser binaries.
  beforePack: async context => {
    const fs = require('node:fs/promises');
    const { Arch } = require('builder-util');
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, 'build/resources/runtime-manifest.json'), 'utf8'));
    const arch = Arch[context.arch];
    if (manifest.platform !== context.electronPlatformName || manifest.arch !== arch) {
      throw new Error(`Prepared ${manifest.platform}/${manifest.arch} resources cannot be packaged for ${context.electronPlatformName}/${arch}. Run prepare:bundle on the target platform and architecture.`);
    }
  },
  win: {
    icon: 'assets/icon.png',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'Lumen-${version}-win-${arch}-setup.${ext}',
    // Signing is enabled by electron-builder when a build supplies CSC_LINK.
    signAndEditExecutable: true,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Lumen',
    deleteAppDataOnUninstall: false,
    runAfterFinish: true,
  },
  mac: {
    icon: 'assets/icon.png',
    target: ['dmg', 'zip'],
    category: 'public.app-category.video',
    artifactName: 'Lumen-${version}-mac-${arch}.${ext}',
    // Local/test builds are ad-hoc signed. Release builds may supply a Developer
    // ID identity; notarization is a separate release configuration step.
    identity: process.env.CSC_NAME || '-',
    hardenedRuntime: !!process.env.CSC_NAME && process.env.CSC_NAME !== '-',
    entitlements: process.env.CSC_NAME && process.env.CSC_NAME !== '-' ? 'build/virtual-devices/host.entitlements' : undefined,
    // Native components are signed by prepare-virtual-devices with their own
    // identifiers/entitlements. Preserve those signatures inside the host seal.
    signIgnore: ['LumenDeviceBridge$', 'LumenActivation\\.node$', 'app\\.lumen\\.studio\\.camera\\.systemextension($|/)', 'LumenAudio\\.pkg$'],
    notarize: process.env.CSC_NAME && process.env.CSC_NAME !== '-' ? undefined : false,
    extendInfo: {
      NSCameraUsageDescription: 'Lumen uses cameras and capture cards as live production sources.',
      NSMicrophoneUsageDescription: 'Lumen uses microphones and capture-card audio for live production.',
      NSLocalNetworkUsageDescription: 'Lumen connects to local presentation displays and capture devices.',
      NSSystemExtensionUsageDescription: 'Lumen sends its Program picture to apps that use a camera.',
    },
  },
  dmg: { title: 'Lumen ${version}' },
  publish: null,
};
