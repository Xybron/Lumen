import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
test('music needs explicit playback and Auto; paused volume, permission loss and media failure stay silent', async () => {
  const globals = globalThis as any;
  const previous = { window: globals.window, Audio: globals.Audio };
  const audioInstances: any[] = [], contexts: any[] = [], errors: string[] = [];
  let plays = 0, publications = 0;
  let pendingPublication: Promise<void> | null = null;
  class Audio {
    listeners = new Map<string, () => void>();
    loop = false; paused = true; src = '';
    constructor() { audioInstances.push(this); }
    addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
    emit(name: string) { this.listeners.get(name)?.(); }
    async play() { plays++; this.paused = false; }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
  }
  class AudioContext {
    currentTime = 0; destination = {}; gains: any[] = [];
    constructor() { contexts.push(this); }
    async resume() {}
    createMediaElementSource() { return { connect() {} }; }
    createMediaStreamDestination() { return { stream: { id: 'music-stream' } }; }
    createGain() {
      const gain = { value: 0, cancelScheduledValues() {}, setValueAtTime(value: number) { this.value = value; }, linearRampToValueAtTime(value: number) { this.value = value; } };
      const node = { gain, connect(target: any) { return target; } }; this.gains.push(node); return node;
    }
  }
  globals.Audio = Audio; globals.window = { AudioContext };
  globals.__musicErrors = errors;
  globals.__musicStudio = { publishPresentationMusic: async () => { publications++; await pendingPublication; } };
  const compiled = await build({ stdin: { contents: "export { useMusicStore } from './src/stores/music'; export { createPinia, setActivePinia } from 'pinia'; export { reactive, nextTick } from 'vue';", resolveDir: path.join(root, 'frontend'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'station-boundaries', setup(builder) {
      builder.onResolve({ filter: /^\.\/(content|identity|studio)$/ }, args => args.importer.endsWith('/stores/music.ts') ? { path: args.path.slice(2), namespace: 'fixture' } : undefined);
      builder.onResolve({ filter: /^@\/lib\/api$/ }, () => ({ path: 'api', namespace: 'fixture' }));
      builder.onResolve({ filter: /^vue-sonner$/ }, () => ({ path: 'toast', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: ({
        content: 'export const useContentStore = () => globalThis.__musicContent;',
        identity: 'export const useIdentityStore = () => globalThis.__musicIdentity;',
        studio: 'export const useStudioStore = () => globalThis.__musicStudio;',
        api: 'export const mediaUrl = value => value;',
        toast: 'export const toast = { error: value => globalThis.__musicErrors.push(value) };',
      } as Record<string, string>)[args.path], loader: 'js' }));
    } }],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
  module.setActivePinia(module.createPinia());
  const identity = module.reactive({ me: { id: 'operator' } as { id: string } | null, ready: true, allowed: true, can() { return this.allowed; } });
  const content = module.reactive({ content: { music: { mode: 'playlist', volume: .6, queue: ['first.wav', 'second.wav'], current: 'first.wav', fadeInMs: 0, fadeOutMs: 0 } }, async updateMusic(patch: any) { Object.assign(this.content.music, patch); } });
  globals.__musicIdentity = identity; globals.__musicContent = content;
  const music = module.useMusicStore();
  try {
    assert.equal(music.autoEnabled, false); assert.equal(music.playing, false); assert.equal(plays, 0);
    await music.play();
    const audio = audioInstances[0], ctx = contexts[0];
    assert.equal(publications, 1); assert.equal(music.playing, true);
    assert.equal(audio.loop, false); assert.equal(ctx.gains[1].gain.value, 0, 'local monitoring starts off');
    audio.emit('ended'); await settle();
    assert.equal(music.playing, false); assert.equal(music.currentTrack, 'first.wav', 'remembered playlist mode alone cannot advance');
    await music.play(); music.pause(); await settle();
    content.content.music.volume = .9; await module.nextTick();
    assert.equal(ctx.gains[0].gain.value, 0, 'paused volume edits cannot restore sound');
    await music.play(); await music.setAutoEnabled(true); audio.emit('ended'); await settle();
    assert.equal(music.currentTrack, 'second.wav', 'explicit Auto advances the queue');
    music.setMonitorEnabled(true); identity.allowed = false; await module.nextTick();
    assert.equal(music.playing, false); assert.equal(music.autoEnabled, false); assert.equal(music.monitorEnabled, false); assert.equal(audio.paused, true); assert.equal(ctx.gains[0].gain.value, 0);
    identity.allowed = true; await module.nextTick();
    let release!: () => void; pendingPublication = new Promise<void>(resolve => { release = resolve; });
    const before = plays, starting = music.play(); await settle(); identity.me = null; await module.nextTick(); release(); await starting;
    assert.equal(plays, before, 'signout cancels playback waiting for Program publication');
    pendingPublication = null; identity.me = { id: 'operator2' }; await module.nextTick();
    await music.play(); audio.emit('error');
    assert.equal(music.playing, false); assert.equal(ctx.gains[0].gain.value, 0); assert.equal(errors.length, 1);
  } finally {
    music.$dispose(); globals.window = previous.window; globals.Audio = previous.Audio;
    for (const key of ['__musicErrors', '__musicStudio', '__musicContent', '__musicIdentity']) delete globals[key];
  }
});
