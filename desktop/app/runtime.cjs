'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

function isLocalUrl(value, origin) {
  try { const url = new URL(value); return url.origin === origin && !url.username && !url.password; }
  catch { return false; }
}

function isExternalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function isPreviewUrl(value, origin) {
  return value === 'about:blank' || typeof value === 'string' && value.startsWith(`blob:${origin}/`);
}

function canGrantPermission(permission, requestingUrl, topUrl, origin) {
  return isLocalUrl(requestingUrl, origin) && isLocalUrl(topUrl, origin)
    && ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'fileSystem', 'local-fonts', 'speaker-selection'].includes(permission);
}

function childEnvironment(environment, values) {
  const result = Object.fromEntries(Object.entries(environment).filter(([name]) =>
    !/^(LUMEN_|VPS_|MEDIA_ENGINE_|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$)/i.test(name)));
  return { ...result, ...values };
}

function resourcePath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || relative.includes('\\') || relative.split('/').some(part => part === '..' || part === '') || relative.includes('\0')) {
    throw new Error('The bundled runtime manifest contains an invalid path.');
  }
  const target = path.resolve(root, relative);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error('The bundled runtime path is outside the application.');
  return target;
}

async function runtimePaths(root) {
  const canonical = await fs.realpath(root);
  const manifest = JSON.parse(await fs.readFile(path.join(canonical, 'runtime-manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error('This Lumen installer does not match this computer.');
  }
  const result = { root: canonical, manifest };
  for (const [key, property] of Object.entries({ node: 'nodeRelativePath', chromium: 'chromiumRelativePath', ffmpeg: 'ffmpegRelativePath', whisper: 'whisperRelativePath', model: 'modelRelativePath' })) {
    const filename = resourcePath(canonical, manifest[property]);
    const real = await fs.realpath(filename);
    if (!real.startsWith(canonical + path.sep) || !(await fs.stat(real)).isFile()) throw new Error(`The bundled ${key} runtime is unavailable.`);
    result[key] = real;
  }
  return result;
}

async function availablePort(preferred = 43117) {
  const probe = port => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)); });
  });
  try { return await probe(preferred); }
  catch (error) { if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error; return probe(0); }
}

module.exports = { isLocalUrl, isExternalUrl, isPreviewUrl, canGrantPermission, childEnvironment, resourcePath, runtimePaths, availablePort };
