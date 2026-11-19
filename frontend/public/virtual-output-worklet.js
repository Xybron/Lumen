// 48 kHz, interleaved stereo, bounded to one outstanding packet. Nothing is
// sent to the speakers: the worklet's output is deliberately left silent.
class LumenProgramAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.offset = 0;
    this.pending = false;
    this.port.onmessage = () => { this.pending = false; };
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    const left = channels[0], right = channels[1] || left;
    for (let i = 0; i < left.length; i++) {
      this.samples[this.offset++] = Number.isFinite(left[i]) ? left[i] : 0;
      this.samples[this.offset++] = Number.isFinite(right[i]) ? right[i] : 0;
      if (this.offset === this.samples.length) {
        if (!this.pending) {
          this.pending = true;
          this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
          this.samples = new Float32Array(2048);
        }
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('lumen-program-audio', LumenProgramAudio);
