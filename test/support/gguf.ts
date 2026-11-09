/** A GGUF header built by hand, for tests: strings, floats, a vocabulary-like array of strings and an array of numbers, then the keys given. */
// A GGUF header with the given keys, built by hand: strings, a float, an array of strings (like a vocabulary) and an array of numbers.
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const str = (s: string): Buffer => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const f32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeFloatLE(n);
  return b;
};
const kvs = (...pairs: [string, number, Buffer][]): Buffer => Buffer.concat(pairs.map(([k, t, v]) => Buffer.concat([str(k), u32(t), v])));
export function gguf(extra: [string, number, Buffer][], vocab = 5): Buffer {
  const tokens = Buffer.concat([u32(8), u64(vocab), ...Array.from({ length: vocab }, (_, i) => str(`tok${i}`))]);
  const scores = Buffer.concat([u32(6), u64(vocab), ...Array.from({ length: vocab }, () => f32(0))]);
  const all: [string, number, Buffer][] = [["general.architecture", 8, str("llama")], ["tokenizer.ggml.tokens", 9, tokens], ["tokenizer.ggml.scores", 9, scores], ...extra];
  return Buffer.concat([Buffer.from("GGUF"), u32(3), u64(0), u64(all.length), kvs(...all), Buffer.alloc(64)]);
}
export const SAMPLING: [string, number, Buffer][] = [["general.sampling.temp", 6, f32(0.6)], ["general.sampling.top_k", 4, u32(20)], ["general.sampling.top_p", 6, f32(0.95)], ["general.sampling.penalty_repeat", 6, f32(1.1)]];
