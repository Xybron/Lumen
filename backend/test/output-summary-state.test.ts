import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('output viewer polling pauses when hidden and rejects responses from old visibility, identity and KeepAlive sessions', async () => {
  const globals = globalThis as any;
  const previous = { document: globals.document, localStorage: globals.localStorage };
  const listeners = new Map<string, () => void>(), hooks: Record<string, () => void> = {};
  const requests: { signal: AbortSignal; resolve: (value: unknown) => void }[] = [];
  globals.document = { visibilityState: 'visible', addEventListener(name: string, callback: () => void) { listeners.set(name, callback); }, removeEventListener(name: string) { listeners.delete(name); } };
  globals.localStorage = { getItem() { return null; } };
  globals.__summaryHooks = hooks;
  globals.__summaryIdentity = { me: { id: 'operator' }, isAuthenticated: true, allowed: true, can() { return this.allowed; } };
  globals.__summaryUi = { revision: 0 };
  // Deliberately allow resolution after abort to exercise the stale-response
  // guard as well as cancellation, rather than relying on fetch alone.
  globals.__summaryRequest = (_url: string, options: { signal: AbortSignal }) => new Promise(resolve => requests.push({ signal: options.signal, resolve }));
  const file = await fs.readFile(path.join(root, 'frontend/src/components/studio/OutputsSummary.vue'), 'utf8');
  const source = file.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1].replace(/^withDefaults\(defineProps[^\n]+$/m, '');
  const compiled = await build({ stdin: { contents: source + '\nexport { viewers, refresh, stop }; export { nextTick } from "vue";', resolveDir: path.join(root, 'frontend'), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{ name: 'summary-boundaries', setup(builder) {
      builder.onResolve({ filter: /^(vue|lucide-vue-next|@\/stores\/(outputs|identity)|@\/lib\/studio\/api)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: ({
        vue: `export { computed, ref, watch, reactive, nextTick } from ${JSON.stringify(path.join(root, 'frontend/node_modules/@vue/runtime-core/dist/runtime-core.esm-bundler.js'))};
          export const onMounted = cb => globalThis.__summaryHooks.mount = cb;
          export const onActivated = cb => globalThis.__summaryHooks.activate = cb;
          export const onDeactivated = cb => globalThis.__summaryHooks.deactivate = cb;
          export const onBeforeUnmount = cb => globalThis.__summaryHooks.unmount = cb;`,
        'lucide-vue-next': 'export const Monitor={}, Link2={}, Volume2={}, VolumeX={};',
        '@/stores/outputs': 'import { reactive } from "vue"; export const useOutputsStore = () => globalThis.__summaryUi = reactive(globalThis.__summaryUi);',
        '@/stores/identity': 'import { reactive } from "vue"; export const useIdentityStore = () => globalThis.__summaryIdentity = reactive(globalThis.__summaryIdentity);',
        '@/lib/studio/api': 'export const studioRequest = (...args) => globalThis.__summaryRequest(...args);',
      } as Record<string, string>)[args.path], loader: 'js', resolveDir: path.join(root, 'frontend') }));
    } }],
  });
  let module: any;
  const settle = async () => { await Promise.resolve(); await module.nextTick(); await Promise.resolve(); };
  const resolve = async (index: number, viewers: number) => { requests[index].resolve({ links: [{ outputId: 'program', viewers }] }); await settle(); };
  try {
    module = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
    hooks.mount(); assert.equal(requests.length, 1);
    await resolve(0, 3); assert.deepEqual(module.viewers.value, { program: 3 });
    globals.document.visibilityState = 'hidden'; listeners.get('visibilitychange')!();
    assert.deepEqual(module.viewers.value, {}); await module.refresh(); assert.equal(requests.length, 1, 'Hidden workspaces do not poll');
    globals.document.visibilityState = 'visible'; listeners.get('visibilitychange')!(); assert.equal(requests.length, 2);
    globals.document.visibilityState = 'hidden'; listeners.get('visibilitychange')!();
    assert.equal(requests[1].signal.aborted, true); await resolve(1, 9); assert.deepEqual(module.viewers.value, {});
    globals.document.visibilityState = 'visible'; listeners.get('visibilitychange')!(); assert.equal(requests.length, 3);
    globals.__summaryIdentity.me = { id: 'another-operator' }; await settle();
    assert.equal(requests[2].signal.aborted, true); assert.equal(requests.length, 4);
    await resolve(2, 99); assert.deepEqual(module.viewers.value, {}, 'Old operator response cannot repaint viewer status');
    await resolve(3, 2); assert.deepEqual(module.viewers.value, { program: 2 });
    globals.__summaryIdentity.allowed = false; await settle();
    assert.deepEqual(module.viewers.value, {}); await module.refresh(); assert.equal(requests.length, 4);
    globals.__summaryIdentity.allowed = true; await settle(); assert.equal(requests.length, 5);
    hooks.deactivate(); assert.equal(requests[4].signal.aborted, true);
    await resolve(4, 7); assert.deepEqual(module.viewers.value, {}); await module.refresh(); assert.equal(requests.length, 5);
    hooks.activate(); assert.equal(requests.length, 6);
    hooks.unmount(); assert.equal(requests[5].signal.aborted, true); assert.equal(listeners.size, 0);
    await resolve(5, 8); assert.deepEqual(module.viewers.value, {});
  } finally {
    module?.stop(); hooks.unmount?.();
    globals.document = previous.document; globals.localStorage = previous.localStorage;
    for (const key of ['__summaryHooks', '__summaryIdentity', '__summaryUi', '__summaryRequest']) delete globals[key];
  }
});
