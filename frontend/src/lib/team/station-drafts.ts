import { useIdentityStore } from '@/stores/identity';
import { useContentStore } from '@/stores/content';
import { useEnginesStore } from '@/stores/engines';
import { newLayer, useStudioStore } from '@/stores/studio';
import { useConfirmation } from '@/composables/useConfirmation';
import { shortId } from '@/lib/ids';
import { validateDraft, type TeamResource } from './model';
import type { Item } from '@/types';

const itemKeys = ['type', 'title', 'body', 'reference', 'subtitle', 'durationMs', 'color', 'typography', 'stanzas'] as const;
const layerKeys = ['name', 'kind', 'visible', 'locked', 'x', 'y', 'width', 'height', 'opacity', 'fit', 'text', 'color', 'background', 'fontSize', 'fontWeight', 'align', 'radius', 'animation'] as const;
function pick(value: Record<string, unknown>, keys: readonly string[]) { return Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, JSON.parse(JSON.stringify(value[key]))])); }
async function localIdentity() {
  const identity = useIdentityStore(); await identity.load();
  if (!identity.isAuthenticated) throw new Error('Sign in to this local station before sharing or importing a draft. Your team login is separate from production control.');
  return identity;
}

/** An explicit safe projection, NEVER a manifest/production.json upload. */
export async function captureStationDrafts(save: (draft: Partial<TeamResource> & Pick<TeamResource, 'kind' | 'name' | 'document'>) => Promise<void>,
  verifyWorkspace: () => void | Promise<void> = () => {}, assertWorkspaceCurrent: () => void = () => {}) {
  const identity = await localIdentity(), content = useContentStore(), engines = useEnginesStore(), studio = useStudioStore();
  await verifyWorkspace();
  await content.load(); await verifyWorkspace();
  await studio.load(); await verifyWorkspace();
  let count = 0;
  const channel = content.channels.find(item => item.id === engines.focusedChannelId) ?? content.channels[0];
  if (channel && identity.can(channel.id, 'author')) {
    const playlist = content.playlistForChannel(channel.id);
    const items = (playlist?.items ?? []).filter(item => ['text', 'scripture', 'lyrics', 'announcement', 'prayer'].includes(item.type))
      .map(item => ({ id: crypto.randomUUID(), ...pick(item as unknown as Record<string, unknown>, itemKeys) }));
    await verifyWorkspace(); assertWorkspaceCurrent();
    await save({ kind: channel.kind === 'scripture' || channel.kind === 'lyrics' ? channel.kind : 'presentation', name: channel.name, document: { schemaVersion: 1, items } }); count++;
    assertWorkspaceCurrent();
  }
  if (studio.selectedScene && identity.can('*', 'author')) {
    const scene = studio.selectedScene;
    const layers = scene.layers.filter(layer => layer.kind !== 'source').map(layer => ({ id: crypto.randomUUID(), ...pick(layer as unknown as Record<string, unknown>, layerKeys) }));
    await verifyWorkspace(); assertWorkspaceCurrent();
    await save({ kind: 'scene', name: scene.name, document: { schemaVersion: 1, background: scene.background, layers } }); count++;
    assertWorkspaceCurrent();
  }
  if (!count) throw new Error('No editable channel or Preview scene is available to share.');
  return count;
}

export async function applyStationDraft(resource: TeamResource, verifyWorkspace: () => void | Promise<void> = () => {}, assertWorkspaceCurrent: () => void = () => {}) {
  validateDraft(resource.document);
  const identity = await localIdentity();
  await verifyWorkspace();
  const { confirmAction } = useConfirmation();
  if (!await confirmAction({ title: 'Add draft to this station?', description: `Add “${resource.name}” as a new local draft. Existing scenes, Program, stream keys and Main audio will not change.`, confirmLabel: 'Add local copy', details: ['Shared drafts contain text and design only. Reconnect media and channel layers locally.', 'Going live remains a separate Studio action.'] })) return;
  // Confirmation may stay open while Auth/workspace selection changes. Recheck
  // the store's captured account/team and the authoritative station identity.
  await verifyWorkspace();
  if (resource.kind === 'scene') {
    if (!identity.can('*', 'author')) throw new Error('Studio author access is required on this station.');
    const studio = useStudioStore(); await studio.load(); await verifyWorkspace();
    const sceneId = shortId('scene');
    const layers = Array.isArray(resource.document.layers) ? resource.document.layers as Record<string, unknown>[] : [];
    const scene = { id: sceneId, name: resource.name.slice(0, 100), background: String(resource.document.background ?? '#151619'),
      layers: layers.filter(layer => layer.kind === 'text' || layer.kind === 'shape').map(layer => newLayer({ ...pick(layer, layerKeys), id: shortId('layer') })) };
    // Do not select Preview, Take, route outputs or modify an audio/source field.
    await studio.edit(draft => { assertWorkspaceCurrent(); draft.scenes.push(scene); });
  } else {
    if (!identity.can('*', 'author')) throw new Error('Channel author access is required on this station.');
    const content = useContentStore(); await content.load(); await verifyWorkspace();
    const playlistId = shortId('plst'), channelId = shortId('chnl');
    const rows = Array.isArray(resource.document.items) ? resource.document.items as Record<string, unknown>[] : [];
    const items = rows.filter(item => ['text', 'scripture', 'lyrics', 'announcement', 'prayer'].includes(String(item.type)))
      .map(row => ({ ...pick(row, itemKeys), id: shortId('itm'), type: row.type, durationMs: Number(row.durationMs) || 30000 }) as Item);
    const saved = await content.save(draft => {
      assertWorkspaceCurrent();
      draft.playlists.push({ id: playlistId, name: resource.name, items });
      draft.channels.push({ id: channelId, name: resource.name, kind: resource.kind === 'scripture' || resource.kind === 'lyrics' ? resource.kind : 'presentation', playlistId, defaultMode: 'manual' });
      draft.sources.push({ id: shortId('src'), kind: 'channel', ref: channelId });
    });
    if (!saved) throw new Error('The local copy could not be added. Your shared draft is still safe.');
  }
}
