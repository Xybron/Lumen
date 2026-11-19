/** Only known provider ingest hosts may receive the station's Program. Keep
 * this check shared by URL configuration, the TLS bridge and FFmpeg setup. */
export function isInstagramIngestHost(host: string): boolean {
  return host === 'live-upload.instagram.com' || /^(?:edge|edgetee)-upload-[a-z0-9]+(?:-[a-z0-9]+)*\.xx\.fbcdn\.net$/.test(host);
}

export function broadcastIngestPrefix(url: URL): string | null {
  if (url.protocol !== 'rtmps:' || url.port && url.port !== '443' || url.username || url.password || url.hash) return null;
  if (url.hostname === 'a.rtmps.youtube.com') return '/live2/';
  if (url.hostname === 'live-api-s.facebook.com' || isInstagramIngestHost(url.hostname)) return '/rtmp/';
  return null;
}

/** Stream URLs contain no credentials. Instagram's key is stored separately. */
export function normalizeInstagramStreamUrl(value: string): string {
  const input = value.trim();
  const invalid = () => new Error('Enter the secure Stream URL from Instagram Live Producer, without the stream key.');
  if (!input || input.length > 2048 || !/^[\x21-\x7e]+$/.test(input) || /[?#\\]/.test(input)) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (!isInstagramIngestHost(url.hostname) || broadcastIngestPrefix(url) !== '/rtmp/' || !['/rtmp', '/rtmp/'].includes(url.pathname)) throw invalid();
  return `rtmps://${url.hostname}:443/rtmp/`;
}
