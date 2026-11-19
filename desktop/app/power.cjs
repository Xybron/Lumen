'use strict';

// A live picture needs an awake display even when the operator minimizes Lumen.
// Keep the stronger assertion only while the engine/recording is active; the
// existing application assertion can then allow normal idle display sleep.
function preventDisplaySleepWhileLive({ powerSaveBlocker, readStatus, pollMs = 3000 }) {
  const abort = new AbortController();
  let blocker, timer, stopped = false;
  async function poll() {
    try {
      const status = await readStatus(abort.signal);
      if (stopped) return;
      const active = ['starting', 'running'].includes(status.state) || !!status.recording;
      if (active && blocker === undefined) blocker = powerSaveBlocker.start('prevent-display-sleep');
      // A watchdog error can leave the renderer alive. Only an explicit stop
      // confirms that it is safe to release an already acquired assertion.
      if (!active && status.state === 'offline' && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
    } catch {
      // A brief status failure must not release protection during a service.
    } finally {
      if (!stopped) { timer = setTimeout(poll, pollMs); timer.unref?.(); }
    }
  }
  void poll();
  return () => {
    stopped = true;
    abort.abort();
    clearTimeout(timer);
    if (blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
  };
}

module.exports = { preventDisplaySleepWhileLive };
