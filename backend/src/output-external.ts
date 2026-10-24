import { protectedOutputRelayOptions, probeProtectedOutput, type ProtectedOutputRelayInfo, type ProtectedOutputRelayOptions } from './broadcast-relay.js';

export interface ExternalOutputStatus {
  configured: boolean;
  verified: boolean;
  url: string | null;
  message: string;
  status?: ProtectedOutputRelayInfo['status'];
}

/** Server-side protected Program link metadata. No saved station configuration,
 * publishing destination or secret is changed by creating/verifying this object. */
export function createExternalOutput(env: NodeJS.ProcessEnv = process.env,
  testOptions: { allowLocalhostForTests?: boolean; timeoutMs?: number } = {}) {
  let options: ProtectedOutputRelayOptions | null = null;
  let state: ExternalOutputStatus = { configured: false, verified: false, url: null,
    message: 'Configure a protected HTTPS relay and separate viewer access token to share Program externally.' };
  try {
    options = protectedOutputRelayOptions(env, testOptions);
    if (options) state = { configured: true, verified: false, url: null, message: 'Verify the protected relay before creating its external Program link.' };
  } catch {
    state.message = 'Protected output setup is incomplete or invalid. Use a public HTTPS relay, a separate stream name and a viewer token different from the publishing key.';
  }
  let verification: Promise<ExternalOutputStatus> | null = null;
  const status = (): ExternalOutputStatus => ({ ...state });
  async function verify(): Promise<ExternalOutputStatus> {
    if (!options) return status();
    if (verification) return verification;
    const selected = options;
    verification = (async () => {
      try {
        const info = await probeProtectedOutput(selected);
        const url = new URL(info.watchUrl, selected.baseUrl);
        url.hash = `key=${encodeURIComponent(selected.viewerToken)}`;
        state = { configured: true, verified: true, url: url.href, status: info.status,
          message: info.status === 'live' ? 'Protected Program output is live. Anyone with this private link can view it.' : 'Protected link verified. Enable Watch in Go Live and start the stream to send Program; nothing starts automatically.' };
      } catch {
        state = { configured: true, verified: false, url: null,
          message: 'Protected relay verification failed. Check its HTTPS address, protected stream name and viewer access settings, then try again.' };
      }
      return status();
    })().finally(() => { verification = null; });
    return verification;
  }
  return { status, verify };
}
