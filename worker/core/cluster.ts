// Pure leader clustering over embeddings, for the weekly ideas digest: related ideas are shown together.
import { cosine } from "./recall";

export interface Vec {
  id: string;
  vec: Float32Array;
}

/**
 * Greedy single-pass clustering: each vector joins the cluster whose running centroid is most similar,
 * if that similarity is at least `threshold`; otherwise it starts a new cluster. Deterministic for a
 * given input order. O(n * clusters), fine for a week of ideas.
 */
export function clusterByCosine(items: Vec[], threshold = 0.8): string[][] {
  const clusters: { ids: string[]; sum: Float32Array }[] = [];
  for (const it of items) {
    let best = -1;
    let bestSim = threshold;
    for (let i = 0; i < clusters.length; i++) {
      const s = cosine(it.vec, clusters[i].sum);
      if (s >= bestSim) {
        bestSim = s;
        best = i;
      }
    }
    if (best < 0) clusters.push({ ids: [it.id], sum: Float32Array.from(it.vec) });
    else {
      const c = clusters[best];
      c.ids.push(it.id);
      for (let k = 0; k < c.sum.length && k < it.vec.length; k++) c.sum[k] += it.vec[k];
    }
  }
  return clusters.map((c) => c.ids).sort((a, b) => b.length - a.length);
}
