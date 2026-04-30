// Motion One transition presets. These are the only timings used in the app —
// everything moves through one of these so the motion language stays coherent.
export const spring = { type: 'spring', stiffness: 260, damping: 28 } as const;

export const easeOutQuart = {
  duration: 0.38,
  easing: [0.25, 1, 0.5, 1] as [number, number, number, number],
};

export const easeOutCubic = {
  duration: 0.24,
  easing: [0.33, 1, 0.68, 1] as [number, number, number, number],
};

export const slideTransition = {
  duration: 0.6,
  easing: [0.25, 1, 0.5, 1] as [number, number, number, number],
};

export const reduce = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
