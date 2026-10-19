(() => {
  const slug = location.pathname.split('/').filter(Boolean)[1];
  const video = document.querySelector('video'), player = document.querySelector('#player'), status = document.querySelector('#status'), placeholder = document.querySelector('#placeholder'), headline = document.querySelector('#headline'), detail = document.querySelector('#detail'), play = document.querySelector('#play'), feedback = document.querySelector('#feedback');
  let hls, source = '', timer, failures = 0, live = false, closing = false, polling = false, pollController;
  function setState(state, message) { status.dataset.state = state; status.textContent = state === 'live' ? 'Live' : state === 'connecting' ? 'Connecting' : 'Offline'; if (message) detail.textContent = message; }
  function stop() { hls?.destroy(); hls = null; source = ''; video.pause(); video.removeAttribute('src'); video.load(); }
  function offline(message) { live = false; stop(); placeholder.hidden = false; play.hidden = true; headline.textContent = 'This stream is offline'; setState('offline', message ?? 'We’ll connect here when the broadcast starts.'); }
  async function playback() { try { await video.play(); } catch { placeholder.hidden = false; play.hidden = false; headline.textContent = 'Ready when you are'; detail.textContent = 'Tap play to watch the live broadcast.'; } }
  function attach(url) {
    stop(); source = url; placeholder.hidden = false; play.hidden = true; headline.textContent = 'Connecting to the broadcast'; setState('connecting', 'The live picture will appear in a moment.');
    // Some Chromium versions advertise native HLS but fail on live feeds.
    // Prefer the bundled, tested MSE player; native HLS remains the fallback
    // for browsers (notably older iOS Safari) without that capability.
    if (window.Hls?.isSupported()) {
      hls = new Hls({ enableWorker: true, liveSyncDurationCount: 2, maxBufferLength: 20, backBufferLength: 10, manifestLoadingTimeOut: 10000, fragLoadingTimeOut: 15000 });
      hls.loadSource(url); hls.attachMedia(video); hls.on(Hls.Events.MANIFEST_PARSED, () => { void playback(); });
      hls.on(Hls.Events.ERROR, (_event, data) => { if (data.fatal) { stop(); placeholder.hidden = false; headline.textContent = 'Reconnecting'; setState('connecting', 'The connection was interrupted. We’re trying again.'); } });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; void playback(); }
    else { placeholder.hidden = false; headline.textContent = 'A newer browser is needed'; setState('offline', 'Open this link in a recent Safari, Chrome, Edge or Firefox browser.'); }
  }
  video.addEventListener('playing', () => { if (live) { placeholder.hidden = true; play.hidden = true; setState('live'); } });
  video.addEventListener('waiting', () => { if (live) setState('connecting'); });
  play.addEventListener('click', () => { void playback(); });
  document.querySelector('#share').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); feedback.textContent = 'Link copied.'; } catch { feedback.textContent = 'Copy the link from your browser’s address bar.'; } });
  document.querySelector('#fullscreen').addEventListener('click', async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if (player.requestFullscreen) await player.requestFullscreen(); else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen(); else feedback.textContent = 'Use your video player’s fullscreen control.'; } catch { feedback.textContent = 'Use your video player’s fullscreen control.'; } });
  async function poll() {
    clearTimeout(timer); if (closing || polling) return;
    polling = true; pollController = new AbortController();
    const deadline = setTimeout(() => pollController?.abort(), 8000);
    try {
      const response = await fetch(`/api/watch/${encodeURIComponent(slug)}`, { cache: 'no-store', signal: pollController.signal }); if (!response.ok) throw new Error('unavailable');
      const data = await response.json(); failures = 0;
      if (data.status === 'live' && typeof data.playlistUrl === 'string' && /^\/hls\//.test(data.playlistUrl)) { live = true; if (source !== data.playlistUrl) attach(data.playlistUrl); }
      else if (data.status === 'connecting') { live = false; if (source) stop(); placeholder.hidden = false; play.hidden = true; headline.textContent = 'The broadcast is starting'; setState('connecting', 'Waiting for the first live picture.'); }
      else offline();
    } catch { failures++; if (failures >= 2) offline('The connection is unavailable. We’ll keep trying.'); else setState('connecting', 'Checking the connection…'); }
    finally { clearTimeout(deadline); polling = false; pollController = null; if (!closing) timer = setTimeout(poll, document.hidden ? 10000 : 3000); }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void poll(); });
  window.addEventListener('pagehide', () => { closing = true; clearTimeout(timer); pollController?.abort(); stop(); });
  void poll();
})();
