// One worker per live broadcast. Program hands off raw tracks. The native
// video codec runs here and FFmpeg receives H.264 pictures ready to publish.
import { AppendOnlyStreamTarget, AudioSample, AudioSampleSource, MkvOutputFormat, Output,
  VideoSample, VideoSampleSource } from 'mediabunny';

interface Tracks {
  video: ReadableStream<VideoFrame>;
  audio: ReadableStream<AudioData>;
}
interface Configuration {
  bitrate: number;
  hardware: boolean;
}
const port = self as unknown as {
  onmessage: ((event: MessageEvent<Tracks | Configuration | 'ack'>) => void) | null;
  postMessage(message: Blob | 'error' | 'ready'): void;
};
let inFlight = false;
let deliverTracks: (tracks: Tracks) => void;
const tracksReady = new Promise<Tracks>(resolve => { deliverTracks = resolve; });
port.onmessage = ({ data }) => {
  if (data === 'ack') inFlight = false;
  else if ('video' in data) deliverTracks(data);
  else void encode(data).catch(() => port.postMessage('error'));
};

async function encode({ hardware, bitrate }: Configuration) {
  let pending: Uint8Array<ArrayBuffer>[] = [], bytes = 0;
  let havePicture = false, haveAudio = false;
  const output = new Output({
    format: new MkvOutputFormat({ appendOnly: true }),
    target: new AppendOnlyStreamTarget(new WritableStream({
      write(chunk) {
        bytes += chunk.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error('Stream transport is too slow');
        pending.push(chunk.slice());
      },
    })),
  });
  const pictures = new VideoSampleSource({
    codec: 'avc', bitrate, bitrateMode: 'constant', hardwareAcceleration: hardware ? 'prefer-hardware' : 'prefer-software',
    fullCodecString: 'avc1.640028', latencyMode: 'realtime', keyFrameInterval: 2,
    onEncodedPacket() { havePicture = true; },
  });
  // Preserve the 48 kHz Program mix. FFmpeg encodes its AAC track once.
  const sound = new AudioSampleSource({ codec: 'pcm-s16', onEncodedPacket() { haveAudio = true; } });
  output.addVideoTrack(pictures, { frameRate: 30 });
  output.addAudioTrack(sound);
  await output.start();
  port.postMessage('ready');
  const { video, audio } = await tracksReady;
  const origin = performance.now();
  let lastVideo = origin, lastAudio = origin;

  // Canvas and Web Audio tracks can have different timestamp origins. Align
  // their first samples to one clock, then preserve each native media timeline.
  async function readVideo() {
    const reader = video.getReader();
    let offset: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Program video ended');
      lastVideo = performance.now();
      const frame = new VideoSample(value);
      try {
        offset ??= (lastVideo - origin) / 1000 - frame.timestamp;
        frame.setTimestamp(frame.timestamp + offset);
        await pictures.add(frame);
      } finally { frame.close(); }
    }
  }
  async function readAudio() {
    const reader = audio.getReader();
    let offset: number | undefined;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Program audio ended');
      lastAudio = performance.now();
      const sample = new AudioSample(value);
      try {
        offset ??= (lastAudio - origin) / 1000 - sample.timestamp;
        sample.setTimestamp(sample.timestamp + offset);
        await sound.add(sample);
      } finally { sample.close(); }
    }
  }
  const timer = setInterval(() => {
    // Bound the muxer's interleave backlog if one source stops producing.
    if (performance.now() - Math.min(lastAudio, lastVideo) > 3500) {
      port.postMessage('error');
      clearInterval(timer);
      return;
    }
    if (havePicture && haveAudio && bytes && !inFlight) {
      port.postMessage(new Blob(pending, { type: 'video/x-matroska' }));
      pending = []; bytes = 0; inFlight = true;
    }
  }, 250);
  try { await Promise.all([readVideo(), readAudio()]); }
  finally { clearInterval(timer); }
}
