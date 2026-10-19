// Pluggable capture-input providers. The hardware-specific build only needs to
// implement `start()` (push frames to the media engine's ingest); `describe()`
// and `health()` are real everywhere. STUB providers (TestPattern/FileLoop) let
// the whole registration → source → health → reconnect loop run with NO capture
// hardware. NDI/DeckLink are interface stubs that throw until built natively.

export interface AgentInput {
  inputId: string;
  label: string;
  signal: 'sdi' | 'hdmi' | 'ndi' | 'test' | 'file';
  transport: 'ndi' | 'srt' | 'rtmp';
  uri?: string;
}
export interface AgentInputHealth {
  inputId: string;
  state: 'idle' | 'streaming' | 'error' | 'no-signal';
}

export interface CaptureInput {
  describe(): AgentInput;
  start(ingestUri: string): Promise<void>;
  health(): AgentInputHealth;
  stop(): void;
}

// STUB — synthetic test pattern. A real build would spawn ffmpeg
// `-f lavfi -i smptebars -f mpegts srt://…`.
export class TestPatternInput implements CaptureInput {
  private streaming = false;
  constructor(private id = 'test-0') {}
  describe(): AgentInput {
    return { inputId: this.id, label: 'Test Pattern', signal: 'test', transport: 'srt' };
  }
  async start(): Promise<void> {
    this.streaming = true;
  }
  health(): AgentInputHealth {
    return { inputId: this.id, state: this.streaming ? 'streaming' : 'idle' };
  }
  stop(): void {
    this.streaming = false;
  }
}

// STUB — loops a local file (a real build would ffmpeg-loop it to SRT/RTMP).
export class FileLoopInput implements CaptureInput {
  private streaming = false;
  constructor(
    private id = 'file-0',
    private file = 'sample.mp4',
  ) {}
  describe(): AgentInput {
    return { inputId: this.id, label: `File: ${this.file}`, signal: 'file', transport: 'srt' };
  }
  async start(): Promise<void> {
    this.streaming = true;
  }
  health(): AgentInputHealth {
    return { inputId: this.id, state: this.streaming ? 'streaming' : 'idle' };
  }
  stop(): void {
    this.streaming = false;
  }
}

// REAL providers — interface stubs that require native SDKs.
export class NdiInput implements CaptureInput {
  constructor(private id: string) {}
  describe(): AgentInput {
    return { inputId: this.id, label: 'NDI Source', signal: 'ndi', transport: 'ndi' };
  }
  async start(): Promise<void> {
    throw new Error('NDI requires the NDI SDK/runtime — build natively');
  }
  health(): AgentInputHealth {
    return { inputId: this.id, state: 'no-signal' };
  }
  stop(): void {}
}

export class DeckLinkInput implements CaptureInput {
  constructor(private id: string) {}
  describe(): AgentInput {
    return { inputId: this.id, label: 'SDI/HDMI (DeckLink)', signal: 'sdi', transport: 'srt' };
  }
  async start(): Promise<void> {
    throw new Error('SDI/HDMI capture requires a Blackmagic DeckLink + SDK — build natively');
  }
  health(): AgentInputHealth {
    return { inputId: this.id, state: 'no-signal' };
  }
  stop(): void {}
}
