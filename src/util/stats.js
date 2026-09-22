// Small, dependency-free statistics helpers used by the agents.

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

export function std(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(sum(xs.map((x) => (x - m) ** 2)) / (xs.length - 1));
}

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const x = a.slice(-n);
  const y = b.slice(-n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) ** 2;
    dy += (y[i] - my) ** 2;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

// Weighted quantile; items: [{ value, weight }]
export function weightedQuantile(items, q) {
  const s = items.filter((i) => i.weight > 0).sort((a, b) => a.value - b.value);
  if (!s.length) return 0;
  const total = sum(s.map((i) => i.weight));
  let acc = 0;
  for (const it of s) {
    acc += it.weight;
    if (acc / total >= q) return it.value;
  }
  return s[s.length - 1].value;
}

export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
export const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

export function logReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

export function softmax(scores) {
  const m = Math.max(...scores);
  const e = scores.map((s) => Math.exp(s - m));
  const t = sum(e);
  return e.map((x) => x / t);
}

// Round a probability vector to whole percents that still sum to 100
// (largest-remainder method).
export function toWholePercents(probs) {
  const raw = probs.map((p) => p * 100);
  const floors = raw.map(Math.floor);
  let rem = 100 - sum(floors);
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && rem > 0; k++, rem--) floors[order[k][1]] += 1;
  return floors;
}
