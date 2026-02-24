import { SVD } from 'ml-matrix';

const SIGNIFICANCE_THRESHOLD = 0.01; // σᵢ > 0.01 · σ_max

/**
 * Project new vector onto subspace spanned by existing vectors via SVD.
 * Returns residual norm (0 = fully redundant, 1 = fully novel).
 * All vectors are L2-normalized (all-MiniLM-L6-v2), so residual is bounded [0, 1].
 */
export function computeNovelty(newVector: Float32Array, existingVectors: Float32Array[]): number {
  if (existingVectors.length === 0) return 1.0;

  const n = existingVectors.length;
  const d = newVector.length;

  // Build matrix E (n × d)
  const data: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Array.from(existingVectors[i]);
  }

  const svd = new SVD(data, { autoTranspose: true });
  const singularValues = svd.diagonal;
  const sigmaMax = singularValues[0];

  if (sigmaMax === 0) return 1.0;

  // V matrix columns for significant singular values
  const V = svd.rightSingularVectors;
  const threshold = SIGNIFICANCE_THRESHOLD * sigmaMax;

  // q as plain array
  const q = Array.from(newVector);

  // Project: proj = V_r · V_r^T · q
  // For each significant column j of V, compute (V_j · q) then accumulate V_j * scalar
  const proj = new Array<number>(d).fill(0);
  for (let j = 0; j < singularValues.length; j++) {
    if (singularValues[j] <= threshold) continue;

    // dot = V_j^T · q
    let dot = 0;
    for (let k = 0; k < d; k++) {
      dot += V.get(k, j) * q[k];
    }

    // proj += dot * V_j
    for (let k = 0; k < d; k++) {
      proj[k] += dot * V.get(k, j);
    }
  }

  // Residual: ‖q − proj‖
  let residualSq = 0;
  for (let k = 0; k < d; k++) {
    const diff = q[k] - proj[k];
    residualSq += diff * diff;
  }

  return Math.sqrt(residualSq);
}

/**
 * Per-observation redundancy via SVD leverage scores.
 * Returns scores (0 = most unique, 1 = most redundant),
 * information rank, and redundancy ratio.
 */
export function computeRedundancyScores(vectors: Float32Array[]): {
  scores: number[];
  rank: number;
  redundancyRatio: number;
} {
  const n = vectors.length;
  if (n === 0) return { scores: [], rank: 0, redundancyRatio: 0 };
  if (n === 1) return { scores: [0], rank: 1, redundancyRatio: 0 };

  // Build matrix E (n × d)
  const data: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = Array.from(vectors[i]);
  }

  const svd = new SVD(data, { autoTranspose: true });
  const singularValues = svd.diagonal;
  const sigmaMax = singularValues[0];

  if (sigmaMax === 0) return { scores: new Array(n).fill(0), rank: 0, redundancyRatio: 1 };

  const threshold = SIGNIFICANCE_THRESHOLD * sigmaMax;
  const U = svd.leftSingularVectors;

  // Count significant components (information rank)
  let rank = 0;
  for (let j = 0; j < singularValues.length; j++) {
    if (singularValues[j] > threshold) rank++;
  }

  // Leverage score per observation: hᵢ = Σⱼ u²ᵢⱼ for significant components
  const leverage = new Array<number>(n);
  let maxLeverage = 0;
  for (let i = 0; i < n; i++) {
    let h = 0;
    for (let j = 0; j < singularValues.length; j++) {
      if (singularValues[j] > threshold) {
        const u = U.get(i, j);
        h += u * u;
      }
    }
    leverage[i] = h;
    if (h > maxLeverage) maxLeverage = h;
  }

  // Normalize: redundancy = 1 − (hᵢ / max(h))
  const scores = leverage.map(h =>
    maxLeverage > 0 ? 1 - (h / maxLeverage) : 0
  );

  return {
    scores,
    rank,
    redundancyRatio: Math.round((1 - rank / n) * 1000) / 1000,
  };
}
