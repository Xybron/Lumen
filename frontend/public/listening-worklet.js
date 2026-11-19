// Transfers bounded PCM blocks to the controller. Never connects microphone
// sound to speakers; the output buffer is explicitly silent.
class LumenListeningProcessor extends AudioWorkletProcessor {
  constructor(){super();this.pending=new Float32Array(1024);this.used=0;}
  process(inputs,outputs) {
    const channels=inputs[0];
    if(channels?.length){
      // Some interfaces expose stereo even when ideal mono was requested.
      // Include every channel so a right-only mixer feed is never lost, and
      // average rather than sum to keep full-scale stereo from clipping.
      // Transfer a small batch instead of allocating and cloning every render
      // quantum (~375 messages/second at 48 kHz). This adds at most 21 ms at
      // 48 kHz and leaves the main thread more time for recognition and UI.
      for(let i=0;i<channels[0].length;i++){
        let sample=0;
        for(const channel of channels)sample+=(channel[i]??0)/channels.length;
        this.pending[this.used++]=sample;
        if(this.used===this.pending.length){
          this.port.postMessage(this.pending,[this.pending.buffer]);
          this.pending=new Float32Array(1024);this.used=0;
        }
      }
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('lumen-listening',LumenListeningProcessor);
