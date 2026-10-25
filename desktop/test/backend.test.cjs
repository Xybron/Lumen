'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('desktop bootstrap seeds a model without overwriting station content and closes its backend over IPC', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-desktop-bootstrap-'));
  const runtime = path.join(directory, 'resources'), station = path.join(directory, 'station');
  const model = path.join(runtime, 'ggml-base.en.bin');
  let child;
  try {
    await fs.mkdir(path.join(runtime, 'lumen', 'backend', 'dist'), { recursive: true });
    await fs.writeFile(model, 'bundled synthetic model');
    await fs.writeFile(path.join(runtime, 'lumen', 'backend', 'package.json'), JSON.stringify({ type: 'module' }));
    await fs.writeFile(path.join(runtime, 'lumen', 'backend', 'dist', 'server.js'), `
      import fs from 'node:fs/promises';
      import path from 'node:path';
      export async function startLumenServer(options) {
        if (options.host !== '127.0.0.1' || options.development !== false) throw new Error('unexpected desktop options');
        return { server: { address: () => ({port: options.port}) }, close: () => fs.writeFile(path.join(process.env.LUMEN_DATA_DIR, 'closed'), 'yes') };
      }
    `);
    async function run() {
      child = spawn(process.execPath, [path.resolve(__dirname, '../app/backend.cjs')], { env: { ...process.env, LUMEN_DESKTOP_RUNTIME_ROOT: runtime, LUMEN_DATA_DIR: station, LUMEN_WHISPER_SERVER: '/synthetic/whisper', LUMEN_DESKTOP_MODEL: model, PORT: '43117' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
      assert.deepEqual(ready, { type: 'ready', port: 43117 });
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) });
      child.send({ type: 'shutdown' });
      assert.equal((await exited)[0], 0);
      child = undefined;
    }
    await run();
    const installed = path.join(station, 'ai', 'models', 'ggml-base.en.bin');
    assert.equal(await fs.readFile(installed, 'utf8'), 'bundled synthetic model');
    assert.equal(await fs.readFile(path.join(station, 'closed'), 'utf8'), 'yes');
    await fs.writeFile(installed, 'retained local model');
    await run();
    assert.equal(await fs.readFile(installed, 'utf8'), 'retained local model');
    assert.deepEqual(await fs.readdir(path.dirname(installed)), ['ggml-base.en.bin']);
  } finally { child?.kill(); await fs.rm(directory, { recursive: true, force: true }); }
});
