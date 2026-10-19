export interface RendererOriginOptions {
  backendUrl: string;
  configuredUrl?: string;
  development: boolean;
  requestOrigin?: string;
  requestReferer?: string;
  requestHost?: string;
}

export interface RendererAttempt {
  origin: string;
  error?: string;
}

export class RendererStartupError extends Error {
  constructor(message: string, public attempts: RendererAttempt[] = [], options?: ErrorOptions) {
    super(message, options);
    this.name = 'RendererStartupError';
  }
}

const unavailableMessage = 'The Studio display page is unavailable. Start the Lumen app or rebuild it, then try starting the engine again.';

function origin(value: string | undefined, localOnly = false): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (localOnly && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}

export function rendererCandidates(options: RendererOriginOptions): string[] {
  const configured = origin(options.configuredUrl);
  if (options.configuredUrl && !configured) {
    throw new RendererStartupError('Lumen’s renderer address is invalid. Set LUMEN_RENDERER_URL to an HTTP or HTTPS address, then restart Lumen.');
  }
  const candidates: Array<string | null> = [configured];
  if (options.development) {
    // Vite may move to another port. Use the control page's real local origin,
    // never an arbitrary remote Origin/Host supplied with an authenticated call.
    candidates.push(origin(options.requestOrigin, true), origin(options.requestReferer, true), origin(options.requestHost ? `http://${options.requestHost}` : undefined, true));
  }
  candidates.push(origin(options.backendUrl));
  if (options.development) candidates.push('http://127.0.0.1:5173', 'http://localhost:5173');
  return [...new Set(candidates.filter((candidate): candidate is string => candidate !== null))];
}

export async function resolveRendererOrigin(options: RendererOriginOptions, stationId: string, activate?: (origin: string) => Promise<void>) {
  const attempts: RendererAttempt[] = [];
  let activationFailed = false;
  for (const candidate of rendererCandidates(options)) {
    try {
      // A public, non-secret station identifier proves a dev proxy reaches this
      // backend before a renderer-only authorization cookie is ever attached.
      const probe = await fetch(`${candidate}/api/studio/engine/probe`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!probe.ok || (await probe.json() as { station?: string }).station !== stationId) throw new Error('This address does not connect to this Lumen station.');
      const page = await fetch(`${candidate}/studio/engine`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
      if (!page.ok || !page.headers.get('content-type')?.includes('text/html')) throw new Error('The Studio display page is not being served at this address.');
      await page.body?.cancel();
      if (activate) {
        try { await activate(candidate); }
        catch (error) { activationFailed = true; throw error; }
      }
      attempts.push({ origin: candidate });
      return { origin: candidate, attempts };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      attempts.push({ origin: candidate, error: `${cause.message}${cause.cause instanceof Error ? `: ${cause.cause.message}` : ''}` });
    }
  }
  throw new RendererStartupError(activationFailed ? 'The Studio display did not become ready. Refresh or restart Lumen, then try starting the engine again.' : unavailableMessage, attempts);
}

export async function waitForStationEngine(hasEngine: () => boolean | undefined, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!hasEngine()) {
    if (Date.now() >= deadline) throw new Error('The display reported ready, but its renderer WebSocket did not connect to this station. Check the /studio/ws proxy routing.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function rendererFailureMessage(error: unknown, phase: string): string {
  if (error instanceof RendererStartupError) return error.message;
  if (phase === 'loading') return 'The Studio display could not connect. Restart Lumen, then try starting the engine again.';
  if (phase === 'ready') return 'The Studio display did not become ready. Refresh Lumen, then try starting the engine again.';
  return 'The Studio engine could not start. Restart Lumen, then try again.';
}
