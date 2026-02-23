/**
 * Cosine similarity via dot product.
 * Vectors MUST be L2-normalized (as all-MiniLM-L6-v2 outputs are),
 * so dot product equals cosine similarity.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
