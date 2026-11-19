import { MULTIVIEW_OUTPUT_ID } from '../../../../shared/multiview-layout';
import { PROGRAM_MONITOR_OUTPUT_ID } from '../../../../shared/program-monitor.js';

const privateMonitors = new Set(['preview', MULTIVIEW_OUTPUT_ID, PROGRAM_MONITOR_OUTPUT_ID]);

/** Full audience outputs need room to encode 1080p motion and readable text.
 * This is a ceiling, not a reserved bitrate: WebRTC still adapts to the link
 * and encoder load. Private monitor feeds keep their existing smaller budget. */
export function outputVideoEncoding(outputId: string, compactProgram = false): RTCRtpEncodingParameters | undefined {
  if (privateMonitors.has(outputId)) return undefined;
  if (outputId === 'program' && compactProgram) return { scaleResolutionDownBy: 2, maxFramerate: 30 };
  return { maxBitrate: 8_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 };
}

/** Reorder supported codecs only; the peer keeps every fallback codec. */
export function outputVideoCodecPreference(outputId: string, compactProgram = false): string | undefined {
  return privateMonitors.has(outputId) || outputId === 'program' && compactProgram ? undefined : 'video/H264';
}

/** A failed startup belongs to this viewer, not every viewer of its output. */
export class OutputEncodingPolicy {
  private defaultCodecWatchers = new Set<string>();
  configuration(watcherKey: string, outputId: string, compactProgram = false, previousStartupFailed = false) {
    let codec = outputVideoCodecPreference(outputId, compactProgram);
    const encoding = outputVideoEncoding(outputId, compactProgram);
    if (codec && previousStartupFailed) this.defaultCodecWatchers.add(watcherKey);
    if (codec && this.defaultCodecWatchers.has(watcherKey)) {
      codec = undefined;
      if (encoding) delete encoding.maxBitrate;
    }
    return { encoding, codec };
  }
  reason(watcherKey: string) { return this.defaultCodecWatchers.has(watcherKey) ? 'preferred-codec-zero-frames' : undefined; }
  forget(watcherKey: string) { this.defaultCodecWatchers.delete(watcherKey); }
  forgetPeer(peerId: string) { for (const key of this.defaultCodecWatchers) if (key.startsWith(`${peerId}:`)) this.defaultCodecWatchers.delete(key); }
  clear() { this.defaultCodecWatchers.clear(); }
}
