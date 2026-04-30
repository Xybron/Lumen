import { ref, type Ref } from 'vue';

// Wall-clock timer driven by performance.now(). Uses a recursive setTimeout
// rather than setInterval, which lets us self-correct for drift each tick and
// stay accurate when the tab is throttled.
export interface TimerHandle {
  remaining: Ref<number>;
  elapsed: Ref<number>;
  running: Ref<boolean>;
  start(durationMs: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  onComplete(cb: () => void): void;
}

export function createTimer(tickHz = 8): TimerHandle {
  const remaining = ref(0);
  const elapsed = ref(0);
  const running = ref(false);

  let endAt = 0;
  let pausedRemaining = 0;
  let total = 0;
  let timer: number | null = null;
  let completeCb: (() => void) | null = null;

  const tickMs = Math.max(1000 / tickHz, 30);

  function clear() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function tick() {
    if (!running.value) return;
    const now = performance.now();
    const left = Math.max(0, endAt - now);
    remaining.value = left;
    elapsed.value = total - left;
    if (left <= 0) {
      running.value = false;
      clear();
      completeCb?.();
      return;
    }
    timer = window.setTimeout(tick, tickMs);
  }

  function start(durationMs: number) {
    clear();
    total = durationMs;
    endAt = performance.now() + durationMs;
    remaining.value = durationMs;
    elapsed.value = 0;
    running.value = durationMs > 0;
    if (running.value) timer = window.setTimeout(tick, tickMs);
  }

  function pause() {
    if (!running.value) return;
    pausedRemaining = Math.max(0, endAt - performance.now());
    running.value = false;
    clear();
  }

  function resume() {
    if (running.value || pausedRemaining <= 0) return;
    endAt = performance.now() + pausedRemaining;
    remaining.value = pausedRemaining;
    running.value = true;
    pausedRemaining = 0;
    timer = window.setTimeout(tick, tickMs);
  }

  function stop() {
    clear();
    running.value = false;
    remaining.value = 0;
    elapsed.value = 0;
    pausedRemaining = 0;
  }

  function onComplete(cb: () => void) {
    completeCb = cb;
  }

  return { remaining, elapsed, running, start, pause, resume, stop, onComplete };
}
