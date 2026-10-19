// Transfers bounded PCM blocks to the controller. Never connects microphone
// sound to speakers; the output buffer is explicitly silent.
class LumenListeningProcessor extends AudioWorkletProcessor {
  process(inputs,outputs) {
    const channels=inputs[0];
    if(channels?.length){
      // Some interfaces expose stereo even when ideal mono was requested.
      // Include every channel so a right-only mixer feed is never lost, and
      // average rather than sum to keep full-scale stereo from clipping.
      const mono=new Float32Array(channels[0].length);
      for(const channel of channels)for(let i=0;i<mono.length;i++)mono[i]+=(channel[i]??0)/channels.length;
      this.port.postMessage(mono);
    }
    for (const output of outputs) for (const channel of output) channel.fill(0);
    return true;
  }
}
registerProcessor('lumen-listening',LumenListeningProcessor);
