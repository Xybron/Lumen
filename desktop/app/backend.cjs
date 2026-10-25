'use strict';

// This entry runs under the separately bundled Node runtime, never Electron.
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomBytes } = require('node:crypto');

let station;
let starting;
let stopping = false;
const send = value => { if (process.connected) process.send(value); };

async function installModel(source, directory) {
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, path.basename(source));
  try { await fs.access(destination); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path.join(directory, `.bundled-${randomBytes(12).toString('hex')}.tmp`);
  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    // Link publishes the complete model atomically and never replaces an import.
    try { await fs.link(temporary, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  } finally { await fs.rm(temporary, { force: true }); }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 20000); timeout.unref();
  try { await starting?.catch(() => {}); await station?.close(); }
  catch (error) { console.error('[desktop] Shutdown failed:', error); code = 1; }
  finally { clearTimeout(timeout); process.exit(code); }
}

process.on('message', message => { if (message?.type === 'shutdown') void stop(); });
process.on('disconnect', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
process.on('SIGTERM', () => { void stop(); });

starting = (async () => {
  const root = process.env.LUMEN_DESKTOP_RUNTIME_ROOT;
  if (!root || !path.isAbsolute(root) || !process.env.LUMEN_DATA_DIR || !process.env.LUMEN_WHISPER_SERVER || !process.env.LUMEN_DESKTOP_MODEL) throw new Error('The desktop runtime configuration is incomplete.');
  await installModel(process.env.LUMEN_DESKTOP_MODEL, path.join(process.env.LUMEN_DATA_DIR, 'ai', 'models'));
  const { startLumenServer } = await import(pathToFileURL(path.join(root, 'lumen', 'backend', 'dist', 'server.js')).href);
  station = await startLumenServer({ port: Number(process.env.PORT), host: '127.0.0.1', development: false });
  send({ type: 'ready', port: station.server.address().port });
})().catch(error => {
  console.error('[desktop] Startup failed:', error);
  send({ type: 'error', message: error.message, code: error.code });
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
