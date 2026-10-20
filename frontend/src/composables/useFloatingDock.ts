import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';

type Point = { x: number; y: number };
interface FloatingDockOptions {
  legacyStorageKeys: string[];
  bottomInset: () => number;
}

const STORAGE_KEY = 'lumen.toolbar.v1';
// Survive route changes even when browser storage is unavailable.
const position = ref<Point | null>(null);
const collapsed = ref(false);
let preferencesLoaded = false;

function saveLayout() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...position.value, collapsed: collapsed.value })); } catch { /* Optional preference. */ }
}

function loadLayout(legacyStorageKeys: string[]) {
  if (preferencesLoaded) return;
  preferencesLoaded = true;
  for (const key of [STORAGE_KEY, ...legacyStorageKeys]) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (!saved || typeof saved !== 'object' || typeof saved.collapsed !== 'boolean') continue;
      const hasPosition = Number.isFinite(saved.x) && Number.isFinite(saved.y);
      if (!hasPosition && (saved.x !== undefined || saved.y !== undefined)) continue;
      collapsed.value = saved.collapsed;
      position.value = hasPosition ? { x: saved.x, y: saved.y } : null;
      if (key !== STORAGE_KEY) saveLayout();
      break;
    } catch { /* Ignore malformed or unavailable preferences. */ }
  }
}

/** Operator-only layout: never changes a scene or a public output. */
export function useFloatingDock({ legacyStorageKeys, bottomInset }: FloatingDockOptions) {
  const element = ref<HTMLElement | null>(null);
  const dragging = ref(false);
  let drag: { pointerId: number; target: HTMLElement; start: Point; origin: Point; previous: Point | null } | null = null;
  let observer: ResizeObserver | undefined;
  let resizeFrame = 0;
  let mounted = false;

  loadLayout(legacyStorageKeys);

  const style = computed<CSSProperties>(() => position.value ? {
    left: `${position.value.x}px`, top: `${position.value.y}px`, bottom: 'auto',
    transform: 'none', translate: 'none',
  } : {});

  function bounded(point: Point): Point {
    const rect = element.value?.getBoundingClientRect();
    return {
      x: Math.max(12, Math.min(point.x, window.innerWidth - (rect?.width ?? 0) - 12)),
      y: Math.max(12, Math.min(point.y, window.innerHeight - (rect?.height ?? 0) - bottomInset())),
    };
  }
  function fit() {
    if (position.value && !drag) { position.value = bounded(position.value); saveLayout(); }
  }
  function scheduleFit() {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(fit);
  }
  function begin(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || drag || !element.value) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    const rect = element.value.getBoundingClientRect();
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, target, start: { x: event.clientX, y: event.clientY }, origin: { x: rect.left, y: rect.top }, previous: position.value };
    dragging.value = true;
  }
  function move(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    position.value = bounded({ x: drag.origin.x + event.clientX - drag.start.x, y: drag.origin.y + event.clientY - drag.start.y });
  }
  function finish(event?: PointerEvent, cancel = false) {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    const current = drag;
    drag = null;
    dragging.value = false;
    if (cancel) position.value = current.previous;
    if (current.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId);
    fit();
    saveLayout();
  }
  function cancel(event?: PointerEvent) { finish(event, true); }
  function reset() { finish(undefined, true); position.value = null; saveLayout(); }
  function keyboard(event: KeyboardEvent) {
    if (event.key === 'Escape' && drag) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
    if (event.key === 'Home') { event.preventDefault(); reset(); return; }
    const directions: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const direction = directions[event.key], rect = element.value?.getBoundingClientRect();
    if (!direction || !rect || drag) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 40 : 10;
    position.value = bounded({ x: rect.left + direction.x * step, y: rect.top + direction.y * step });
    saveLayout();
  }
  function escape(event: KeyboardEvent) { if (event.key === 'Escape' && drag) keyboard(event); }
  watch(collapsed, async () => { saveLayout(); await nextTick(); if (mounted) fit(); });
  onMounted(() => {
    mounted = true;
    fit();
    observer = new ResizeObserver(scheduleFit);
    if (element.value) observer.observe(element.value);
    window.addEventListener('resize', scheduleFit);
    window.addEventListener('keydown', escape);
  });
  onBeforeUnmount(() => {
    finish();
    // A centered/reset dock still needs a concrete anchor when its label changes
    // in the next workspace. Preserve its on-screen position before removal.
    const rect = element.value?.getBoundingClientRect();
    if (rect) position.value = { x: rect.left, y: rect.top };
    saveLayout();
    mounted = false;
    observer?.disconnect(); cancelAnimationFrame(resizeFrame);
    window.removeEventListener('resize', scheduleFit);
    window.removeEventListener('keydown', escape);
  });
  return { element, style, collapsed, dragging, begin, move, finish, cancel, reset, keyboard };
}
