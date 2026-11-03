import type { BroadcastSession, BroadcastSinkStatus } from '../../../shared/broadcast';

const names = { youtube: 'YouTube', facebook: 'Facebook', watch: 'Lumen Watch' };
export interface BroadcastNotice {
  key: string;
  tone: 'danger' | 'warning' | 'info';
  label: string;
  message: string;
}
function sinks(session: BroadcastSession) { return [...session.destinations, session.watch]; }
function reconnecting(sink: BroadcastSinkStatus) {
  return sink.state === 'retrying' || (sink.state === 'connecting' && sink.retries > 0);
}
export function streamNotice(session: BroadcastSession | null, observedActiveId: string | null, unreachable: boolean): BroadcastNotice | null {
  const id = session?.id ?? observedActiveId;
  if (!id) return null;
  if (unreachable) return { key: id + '/unreachable', tone: 'warning', label: 'Stream status unknown',
    message: 'Lumen can’t reach the station to confirm whether it is still streaming.' };
  if (!session || session.state === 'error') return { key: id + '/interrupted', tone: 'danger', label: 'Stream interrupted',
    message: 'The station has stopped streaming. Open stream controls to check what happened.' };
  if (session.state === 'stopped') return session.id === observedActiveId ? { key: id + '/ended', tone: 'info', label: 'Stream ended',
    message: 'Streaming has ended on this station.' } : null;
  if (session.state === 'stopping') return null;
  const affected = sinks(session).filter(sink => reconnecting(sink) || sink.state === 'error' || sink.state === 'stopped');
  if (!affected.length) return null;
  const failed = affected.some(sink => sink.state === 'error'), retry = affected.some(reconnecting);
  const descriptions = affected.map(sink => names[sink.id] + (reconnecting(sink) ? ' is reconnecting.' :
    sink.state === 'error' ? ' lost its connection.' : ' was stopped.'));
  const sending = sinks(session).filter(sink => sink.state === 'live').map(sink => names[sink.id]);
  if (sending.length) descriptions.push('Still sending to ' + sending.join(' and ') + '.');
  return { key: [id, ...affected.map(sink => sink.id + '/' + (reconnecting(sink) ? 'retry' : sink.state))].join('|'),
    tone: failed ? 'danger' : retry ? 'warning' : 'info', label: failed ? 'Connection lost' : retry ? 'Reconnecting' : 'Destination stopped',
    message: descriptions.join(' ') };
}

export function restoredNotice(current: BroadcastSession | null, previous?: BroadcastSession | null): BroadcastNotice | null {
  if (!current || current.state !== 'live' || previous?.id !== current.id) return null;
  const restored = sinks(current).filter(sink => {
    const last = sinks(previous).find(item => item.id === sink.id);
    return sink.state === 'live' && last && (reconnecting(last) || last.state === 'error' || sink.retries > last.retries);
  });
  if (!restored.length) return null;
  return { key: current.id + '/restored/' + restored.map(sink => sink.id).join('-'), tone: 'info',
    label: 'Connection restored', message: 'Sending to ' + restored.map(sink => names[sink.id]).join(' and ') + ' again.' };
}
