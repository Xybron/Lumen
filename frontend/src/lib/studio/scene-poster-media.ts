import { ref, shallowRef } from 'vue';
import { api } from '@/lib/api';
import { mediaAssetUrl } from './media-library';

const thumbnails = shallowRef<ReadonlyMap<string, string | null>>(new Map());
const loading = ref(false);
const requested = new Set<string>();
let pending: Promise<void> | null = null;
let loadedAt = 0;

// All scene cards share one read-only catalog. Listing never creates a poster
// or starts a decoder, and there is no background polling during production.
export function ensureScenePosterMedia(paths: string[]) {
  const local = paths.map(path => path.replace(/^\/+/, '')).filter(path => path.startsWith('media/backgrounds/'));
  const missing = local.filter(path => !thumbnails.value.has(path) && !requested.has(path));
  if (!local.length || pending || !missing.length && Date.now() - loadedAt < 30_000) return;
  missing.forEach(path => requested.add(path));
  loading.value = true;
  pending = Promise.resolve().then(async () => {
    try {
      const files = await api.listMedia('backgrounds');
      thumbnails.value = new Map(files.map(file => [file.path, file.thumbnail ?? null]));
    } catch { /* Artwork is optional; keep the last known catalog. */ }
    loadedAt = Date.now();
  }).finally(() => { pending = null; loading.value = false; });
}

export function scenePosterMedia(path: string | undefined, kind: 'image' | 'video'): string | undefined {
  if (!path) return;
  const normalized = path.replace(/^\/+/, '');
  const thumbnail = thumbnails.value.get(normalized);
  if (thumbnail) return mediaAssetUrl(thumbnail);
  // Wait for the catalog before downloading an original that may be 4K. Vue
  // rechecks once the single shared request resolves, including on failure.
  if (normalized.startsWith('media/backgrounds/') && !thumbnails.value.has(normalized) && (loading.value || !loadedAt)) return;
  // Never download a whole video or animate a GIF just to fill a tiny card.
  if (kind === 'image' && !/\.gif(?:$|[?#])/i.test(path)) return mediaAssetUrl(path);
}
