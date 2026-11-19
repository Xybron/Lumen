export type RendererDiagnosticsSample = {
  details: unknown | null;
  state: 'available' | 'unavailable' | 'timeout';
};

/** A diagnostic timeout must not enqueue another evaluation on a stuck page.
 * Keep sharing its bounded response until the underlying read actually settles;
 * a replacement renderer has its own slot and can be inspected immediately. */
export function createRendererDiagnosticsSampler<T extends object>(
  read: (target: T) => Promise<unknown>, timeoutMs = 1500,
) {
  const pending = new WeakMap<T, Promise<RendererDiagnosticsSample>>();
  return (target: T | null): Promise<RendererDiagnosticsSample> => {
    if (!target) return Promise.resolve({ details: null, state: 'unavailable' });
    const existing = pending.get(target);
    if (existing) return existing;

    let resolve!: (sample: RendererDiagnosticsSample) => void;
    const response = new Promise<RendererDiagnosticsSample>(done => { resolve = done; });
    pending.set(target, response);
    const timer = setTimeout(() => resolve({ details: null, state: 'timeout' }), timeoutMs);
    const finish = (sample: RendererDiagnosticsSample) => {
      clearTimeout(timer);
      pending.delete(target);
      resolve(sample);
    };
    void Promise.resolve().then(() => read(target)).then(
      details => finish({ details: details ?? null, state: details == null ? 'unavailable' : 'available' }),
      () => finish({ details: null, state: 'unavailable' }),
    );
    return response;
  };
}
