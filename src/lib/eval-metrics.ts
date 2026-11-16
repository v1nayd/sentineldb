/** Ranking metrics for the Milestone 4 evaluation (eval/README.md). `ranked` = ids best first; `relevant` = the judged set. */
export function precisionAt(ranked: number[], relevant: Set<number>, k: number): number {
  if (k <= 0) return 0;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / k;
}
export function recallAt(ranked: number[], relevant: Set<number>, k: number): number {
  if (relevant.size === 0) return 0;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / relevant.size;
}
/** Hits in the top k divided by the most hits possible there, min(k, R): reaches 1 whatever the size of the relevant set. */
export function normalizedRecallAt(ranked: number[], relevant: Set<number>, k: number): number {
  if (relevant.size === 0 || k <= 0) return 0;
  return ranked.slice(0, k).filter((id) => relevant.has(id)).length / Math.min(k, relevant.size);
}
/** Precision at R, the number of relevant items: also reaches 1 whatever R is. */
export const rPrecision = (ranked: number[], relevant: Set<number>) => precisionAt(ranked, relevant, relevant.size);
export function reciprocalRank(ranked: number[], relevant: Set<number>): number {
  const i = ranked.findIndex((id) => relevant.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

/**
 * A seeded permutation used only to order candidates with EQUAL scores: id -> position. Ties must not fall back to
 * incident id: ids are chronological and the families are not spread evenly over time (mean id of ransomware 78, of
 * phishing 142 in the demo seed), so an id tie-break would favour some families for no reason. Same seed + same set of
 * ids = same permutation, whatever the input order (mulberry32 + Fisher-Yates over the sorted ids).
 */
export function tieBreakOrder(ids: number[], seed: number): Map<number, number> {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = [...ids].sort((a, b) => a - b);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return new Map(order.map((id, pos) => [id, pos]));
}
/** Sort ids by score descending; equal scores follow the tie-break permutation. */
export function rankByScore(ids: number[], score: (id: number) => number, ties: Map<number, number>): number[] {
  return [...ids].sort((a, b) => score(b) - score(a) || ties.get(a)! - ties.get(b)!);
}

/** Exact two-sided sign test on paired differences; ties are dropped. Descriptive only: p = 1 when nothing differs. */
export function signTest(diffs: number[], eps = 1e-9): { better: number; equal: number; worse: number; p: number } {
  const better = diffs.filter((d) => d > eps).length;
  const worse = diffs.filter((d) => d < -eps).length;
  const n = better + worse;
  let tail = 0, c = 1; // c = C(n, i)
  for (let i = 0; i <= Math.min(better, worse); i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return { better, equal: diffs.length - n, worse, p: n === 0 ? 1 : Math.min(1, 2 * tail * 2 ** -n) };
}
export const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
