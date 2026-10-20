import { onBeforeUnmount } from 'vue';
import type { BroadcastMsg } from '@/types';
import { sendWs, startWs, subscribeWs, subscribeTopics, unsubscribeTopics } from './ws';

export { subscribeTopics, unsubscribeTopics };

const CHANNEL = 'lumen-state';

const supported = typeof BroadcastChannel !== 'undefined';
const sharedChannel = supported ? new BroadcastChannel(CHANNEL) : null;

// Bring the WS singleton up on first import. It auto-reconnects in the
// background and is harmless on dev where Vite proxies it through.
startWs();

// Lifecycle-free sender for stores and other non-component contexts.
export function broadcast(msg: BroadcastMsg) {
  sharedChannel?.postMessage(msg);
  sendWs(msg);
}

export function useBroadcast(onMessage?: (msg: BroadcastMsg) => void) {
  const ch = supported ? new BroadcastChannel(CHANNEL) : null;

  let unsubWs: (() => void) | null = null;

  if (onMessage) {
    if (ch) ch.onmessage = (e: MessageEvent<BroadcastMsg>) => onMessage(e.data);
    unsubWs = subscribeWs(onMessage);
  }

  onBeforeUnmount(() => {
    ch?.close();
    unsubWs?.();
  });

  function send(msg: BroadcastMsg) {
    ch?.postMessage(msg);
    sendWs(msg);
  }

  return { send, supported };
}
