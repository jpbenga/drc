function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function logit(p) {
  const x = clamp(p, 1e-12, 1 - 1e-12);
  return Math.log(x / (1 - x));
}

class PlattCalibrator {
  constructor({ a = 1, b = 0, lr = 0.03, reg = 0.001, clipA = [-3, 3], clipB = [-3, 3] } = {}) {
    this.a = a;
    this.b = b;
    this.lr = lr;
    this.reg = reg;
    this.clipA = clipA;
    this.clipB = clipB;
    this.n = 0;
  }

  predict(pRaw) {
    const z = this.a * logit(pRaw) + this.b;
    return sigmoid(z);
  }

  update(pRaw, outcome) {
    const y = outcome ? 1 : 0;
    const q = this.predict(pRaw);
    const diff = q - y;

    const da = diff * logit(pRaw) + this.reg * this.a;
    const db = diff + this.reg * this.b;

    this.a = clamp(this.a - this.lr * da, this.clipA[0], this.clipA[1]);
    this.b = clamp(this.b - this.lr * db, this.clipB[0], this.clipB[1]);
    this.n += 1;
  }

  snapshot() {
    return { a: this.a, b: this.b, n: this.n };
  }
}

module.exports = {
  PlattCalibrator,
  clamp,
  logit,
  sigmoid,
};
