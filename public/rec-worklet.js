// Kayıt için ham sesi (PCM) toplayıp ana iş parçacığına parça parça gönderir.
// Her 128 örnekte bir mesaj atmamak için yaklaşık 0,1 sn biriktirir.

const BATCH = 4096;

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(BATCH);
    this.right = new Float32Array(BATCH);
    this.n = 0;
    // Kayıt bitti: kalanı gönder, ardından bittiğini bildir (mesajlar sırayla gider).
    this.port.onmessage = () => {
      this.flush();
      this.port.postMessage({ done: true });
    };
  }

  flush() {
    if (!this.n) return;
    const left = this.left.slice(0, this.n);
    const right = this.right.slice(0, this.n);
    this.port.postMessage({ left, right }, [left.buffer, right.buffer]);
    this.n = 0;
  }

  process(inputs) {
    const [l, r = l] = inputs[0];
    if (!l) return true;
    for (let i = 0; i < l.length; i++) {
      this.left[this.n] = l[i];
      this.right[this.n] = r[i];
      if (++this.n === BATCH) this.flush();
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
