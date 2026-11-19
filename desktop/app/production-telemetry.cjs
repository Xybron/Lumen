'use strict';

// Electron reports working-set memory in KiB for its desktop processes. This
// deliberately does not pretend to include the separately spawned production
// services, or to be a sum of JavaScript heaps.
function desktopMemory(metrics, sampledAt = Date.now()) {
  const result = { available: false, bytes: null, processes: 0, sampledAt, scope: 'desktop-processes', metric: 'working-set' };
  if (!Array.isArray(metrics) || !metrics.length) return result;
  const seen = new Set();
  let kilobytes = 0;
  for (const entry of metrics) {
    if (!Number.isInteger(entry?.pid) || entry.pid <= 0 || seen.has(entry.pid)) continue;
    seen.add(entry.pid);
    const value = entry.memory?.workingSetSize;
    if (!Number.isFinite(value) || value < 0) return result;
    kilobytes += value;
  }
  const bytes = Math.round(kilobytes * 1024);
  if (!seen.size || !Number.isSafeInteger(bytes) || bytes <= 0) return result;
  return { ...result, available: true, bytes, processes: seen.size };
}

function operatorIdentity(identity) {
  return !!identity?.user && (identity.user.isAdmin === true || identity.grants?.some(grant =>
    grant.channelId === '*' && ['author', 'owner'].includes(grant.role)) === true);
}

function registerProductionTelemetry({ app, ipcMain, session, origin, trustedSender, now = Date.now }) {
  const channel = 'lumen:production:memory';
  let closed = false, sample = null;
  function allowedFrame(event) {
    if (!trustedSender(event)) return false;
    try { return ['/', '/studio', '/media'].includes(new URL(event.senderFrame.url).pathname); }
    catch { return false; }
  }
  ipcMain.handle(channel, async event => {
    if (closed || !allowedFrame(event)) throw new Error('Production readings require this station’s operator window.');
    const response = await session.fetch(`${origin}/api/auth/me`, { signal: AbortSignal.timeout(3000) });
    const identity = response.ok ? await response.json() : null;
    if (!operatorIdentity(identity)) throw new Error('Sign in with Studio operator access to read production status.');
    // A window can leave the operator surface while authentication is pending.
    if (closed || !allowedFrame(event)) throw new Error('The operator window is no longer available.');
    const time = now();
    if (sample && time >= sample.sampledAt && time - sample.sampledAt < 1500) return sample;
    try { sample = desktopMemory(app.getAppMetrics(), time); }
    catch { sample = desktopMemory(null, time); }
    return sample;
  });
  return { close() { closed = true; sample = null; ipcMain.removeHandler(channel); } };
}

module.exports = { desktopMemory, registerProductionTelemetry };
