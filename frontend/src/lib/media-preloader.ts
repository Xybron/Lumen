type Asset = { kind: 'image' | 'video'; url: string };
type Entry = { asset: Asset; element: HTMLImageElement | HTMLVideoElement; owners: Set<string> };

/** Warm only each channel's next asset. Channels sharing artwork share a loader.
 * The actual preview/output players have their own independent media elements. */
export function createMediaPreloader() {
  const entries = new Map<string, Entry>(), owners = new Map<string, string>();
  function release(owner: string) {
    const key = owners.get(owner);
    if (!key) return;
    owners.delete(owner);
    const entry = entries.get(key);
    if (!entry) return;
    entry.owners.delete(owner);
    if (entry.owners.size) return;
    entries.delete(key);
    if (entry.asset.kind === 'video') {
      const video = entry.element as HTMLVideoElement;
      video.pause(); video.removeAttribute('src'); video.load();
    } else entry.element.removeAttribute('src');
  }
  function prepare(owner: string, asset?: Asset) {
    const key = asset ? `${asset.kind}:${asset.url}` : undefined;
    if (key && owners.get(owner) === key) return;
    release(owner);
    if (!asset || !key) return;
    let entry = entries.get(key);
    if (!entry) {
      const element = asset.kind === 'image' ? new Image() : document.createElement('video');
      if (asset.kind === 'video') { const video = element as HTMLVideoElement; video.preload = 'auto'; video.muted = true; }
      element.src = asset.url;
      entry = { asset, element, owners: new Set() }; entries.set(key, entry);
    }
    owners.set(owner, key); entry.owners.add(owner);
  }
  return { prepare, release };
}
