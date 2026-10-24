(() => {
  const path = location.pathname.split('/').filter(Boolean), slug = path.at(-1), workspace = path.length === 3 ? path[1] : null;
  const scope = `${workspace ? `${workspace}/` : ''}${slug}`;
  const parameters = new URLSearchParams(location.hash.slice(1));
  let key = parameters.get('key') || '';
  const requestedAudio = parameters.get('audio') === '1';
  parameters.delete('key');
  // Fragments are never sent to the relay/reverse-proxy. Consume immediately,
  // keep only in this page's memory for session renewal, and clear on exit.
  history.replaceState(null, '', location.pathname);
  const video = document.querySelector('video'), output = document.querySelector('#output'), placeholder = document.querySelector('#placeholder'), headline = document.querySelector('#headline'), detail = document.querySelector('#detail'), play = document.querySelector('#play');
  let hls, source = '', live = false, closing = false, polling = false, timer, renewal, controller;
  video.muted = !requestedAudio;
  function message(title, description) { placeholder.hidden = false; headline.textContent = title; detail.textContent = description; play.hidden = true; document.body.classList.remove('playing'); }
  function stop() { hls?.destroy(); hls = null; source = ''; video.pause(); video.removeAttribute('src'); video.load(); document.body.classList.remove('playing'); }
  async function exchange() {
    if (!key) return;
    if (!/^[\x21-\x7e]{32,256}$/.test(key)) throw new Error('access');
    const response = await fetch(`/api/output/${scope}/session`, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Authorization: `Bearer ${key}` }, body: '{}' });
    if (!response.ok) throw new Error(response.status === 401 ? 'access' : 'unavailable');
    const data = await response.json(), remaining = Date.parse(data.expiresAt) - Date.now();
    clearTimeout(renewal);
    if (!closing && remaining > 0) renewal = setTimeout(renew, Math.max(1000, remaining - 300000));
  }
  function renew() {
    if (closing || !key) return;
    void exchange().catch(error => {
      if (closing) return;
      if (error.message === 'access') { key = ''; stop(); message('Output access expired', 'Open a current share link to reconnect.'); }
      else renewal = setTimeout(renew, 30000);
    });
  }
  async function playback() {
    try { await video.play(); }
    catch { message('Program is ready', requestedAudio ? 'Play to enable sound on this device.' : 'Play to view the live picture.'); play.hidden = false; }
  }
  function attach(url) {
    stop(); source = url; message('Connecting to Program', 'Waiting for the first live picture.');
    if (window.Hls?.isSupported()) {
      hls = new Hls({ enableWorker: true, liveSyncDurationCount: 2, maxBufferLength: 20, backBufferLength: 10, manifestLoadingTimeOut: 10000, fragLoadingTimeOut: 15000 });
      hls.loadSource(url); hls.attachMedia(video); hls.on(Hls.Events.MANIFEST_PARSED, () => { void playback(); });
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { stop(); message('Reconnecting to Program', 'The connection was interrupted.'); } });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; void playback(); }
    else message('A newer browser is needed', 'Use a recent browser or OBS Browser Source.');
  }
  async function poll() {
    clearTimeout(timer); if (closing || polling) return;
    polling = true; controller = new AbortController(); const deadline = setTimeout(() => controller?.abort(), 8000);
    try {
      const response = await fetch(`/api/watch/${scope}`, { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal });
      if (response.status === 401) { stop(); message('Output access required', 'Open a current share link. It may have expired or been revoked.'); return; }
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (data.status === 'live' && typeof data.playlistUrl === 'string' && data.playlistUrl.startsWith(`/hls/${scope}/`)) { live = true; if (source !== data.playlistUrl) attach(data.playlistUrl); }
      else { live = false; if (source) stop(); message(data.status === 'connecting' ? 'Program is starting' : 'Program is offline', 'This link follows the live Program when the station is sending.'); }
    } catch { live = false; stop(); message('Connecting to Program', 'The relay is unavailable. We’ll keep trying.'); }
    finally { clearTimeout(deadline); controller = null; polling = false; if (!closing) timer = setTimeout(poll, document.hidden ? 10000 : 3000); }
  }
  video.addEventListener('playing', () => { if (live) { placeholder.hidden = true; play.hidden = true; document.body.classList.add('playing'); } });
  play.addEventListener('click', () => { void playback(); });
  output.addEventListener('dblclick', () => { void output.requestFullscreen?.().catch(() => {}); });
  document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 'f') void output.requestFullscreen?.().catch(() => {}); if (event.key.toLowerCase() === 'm') { video.muted = !video.muted; void playback(); } });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('pagehide', () => { closing = true; key = ''; clearTimeout(timer); clearTimeout(renewal); controller?.abort(); stop(); });
  function start() {
    void exchange().then(poll).catch(error => {
      if (closing) return;
      if (error.message === 'access') { key = ''; message('Output access required', 'Open a current share link. It may have expired or been revoked.'); }
      else { message('Connecting to Program', 'The relay is unavailable. We’ll keep trying.'); renewal = setTimeout(start, 3000); }
    });
  }
  start();
})();
