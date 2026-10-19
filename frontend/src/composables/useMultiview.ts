import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type CSSProperties } from 'vue';
import { fitMultiviewWindow, type MultiviewWindowBox } from '@/lib/studio/multiview-window';

const storageKey = 'lumen.multiview.v1';
function readPreferences(): { open: boolean; box: Partial<MultiviewWindowBox> | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (saved && typeof saved === 'object') return { open: saved.open === true, box: saved.box ?? null };
  } catch { /* Optional operator preference. */ }
  return { open: false, box: null };
}
const saved = readPreferences();
const open = ref(saved.open), box = ref<Partial<MultiviewWindowBox> | null>(saved.box);
function persist() {
  try { localStorage.setItem(storageKey, JSON.stringify({ open: open.value, box: box.value })); } catch { /* Private browsing. */ }
}
watch([open, box], persist, { deep: true });

/** One overlay state across channel/Studio route components. */
export function useMultiview() {
  return { open, show: () => { open.value = true; }, collapse: () => { open.value = false; }, toggle: () => { open.value = !open.value; } };
}

export function useMultiviewWindow() {
  const element = ref<HTMLElement | null>(null), dragging = ref(false), resizing = ref(false);
  let pointer: { id: number; target: HTMLElement; kind: 'move' | 'resize'; x: number; y: number; origin: MultiviewWindowBox } | null = null;
  function fit() { box.value = fitMultiviewWindow(box.value, window.innerWidth, window.innerHeight); }
  const style = computed<CSSProperties>(() => {
    const fitted = fitMultiviewWindow(box.value, window.innerWidth, window.innerHeight);
    return { left: `${fitted.x}px`, top: `${fitted.y}px`, width: `${fitted.width}px`, height: `${fitted.height}px` };
  });
  function begin(event: PointerEvent, kind: 'move' | 'resize' = 'move') {
    if (!event.isPrimary || event.button !== 0 || pointer) return;
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.focus({ preventScroll: true }); target.setPointerCapture(event.pointerId);
    pointer = { id: event.pointerId, target, kind, x: event.clientX, y: event.clientY,
      origin: fitMultiviewWindow(box.value, window.innerWidth, window.innerHeight) };
    dragging.value = kind === 'move'; resizing.value = kind === 'resize';
  }
  function move(event: PointerEvent) {
    if (!pointer || event.pointerId !== pointer.id) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    box.value = fitMultiviewWindow(pointer.kind === 'move'
      ? { ...pointer.origin, x: pointer.origin.x + dx, y: pointer.origin.y + dy }
      : { ...pointer.origin, width: pointer.origin.width + dx, height: pointer.origin.height + dy }, window.innerWidth, window.innerHeight);
  }
  function finish(event?: PointerEvent, cancelled = false) {
    if (!pointer || event && pointer.id !== event.pointerId) return;
    const active = pointer; pointer = null;
    if (cancelled) box.value = active.origin;
    dragging.value = false; resizing.value = false;
    if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id);
    fit(); persist();
  }
  function cancel(event?: PointerEvent) { finish(event, true); }
  function reset() { finish(undefined, true); box.value = null; fit(); persist(); }
  function keyboard(event: KeyboardEvent, resize = false) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); reset(); return; }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = arrows[event.key]; if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const fitted = fitMultiviewWindow(box.value, window.innerWidth, window.innerHeight), step = event.shiftKey ? 40 : 10;
    box.value = fitMultiviewWindow(resize
      ? { ...fitted, width: fitted.width + direction[0] * step, height: fitted.height + direction[1] * step }
      : { ...fitted, x: fitted.x + direction[0] * step, y: fitted.y + direction[1] * step }, window.innerWidth, window.innerHeight);
  }
  watch(open, async value => {
    if (value) {
      await nextTick(); fit();
      element.value?.querySelector<HTMLElement>('[data-testid="studio-multiview"]')?.focus({ preventScroll: true });
    }
  });
  onMounted(() => { fit(); window.addEventListener('resize', fit); });
  onBeforeUnmount(() => { finish(); window.removeEventListener('resize', fit); });
  return { element, style, dragging, resizing, begin, move, finish, cancel, reset, keyboard };
}
