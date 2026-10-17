class AuraRecorder extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(1024); this.offset = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.flush(); this.port.postMessage({ flushed: true }); }
    };
  }
  flush() {
    if (!this.offset) return;
    const chunk = this.buffer.slice(0, this.offset);
    this.port.postMessage({ samples: chunk }, [chunk.buffer]); this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (channels?.length) {
      for (let i = 0; i < channels[0].length; i++) {
        let value = 0;
        for (const channel of channels) value += channel[i];
        this.buffer[this.offset++] = value / channels.length;
        if (this.offset === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('aura-recorder', AuraRecorder);
