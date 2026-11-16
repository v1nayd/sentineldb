import { describe, expect, it } from "vitest";
import { mean, normalizedRecallAt, precisionAt, rPrecision, rankByScore, recallAt, reciprocalRank, signTest, tieBreakOrder } from "../src/lib/eval-metrics";

describe("evaluation metrics (hand-computed cases)", () => {
  const ranked = [7, 3, 9, 1, 4, 8];
  const rel = new Set([3, 4, 5]);
  it("precision@k counts relevant ids in the first k, divided by k", () => {
    expect(precisionAt(ranked, rel, 1)).toBe(0);
    expect(precisionAt(ranked, rel, 5)).toBeCloseTo(2 / 5);
    expect(precisionAt(ranked, rel, 10)).toBeCloseTo(2 / 10); // k beyond the list: missing positions count as misses
  });
  it("recall@k divides by the number of relevant items (5 is never retrieved)", () => {
    expect(recallAt(ranked, rel, 5)).toBeCloseTo(2 / 3);
    expect(recallAt(ranked, new Set(), 5)).toBe(0);
  });
  it("normalised recall divides by min(k, R), so a large family can still reach 1", () => {
    const big = new Set(Array.from({ length: 40 }, (_, i) => i + 1));
    const top10 = Array.from({ length: 10 }, (_, i) => i + 1);
    expect(recallAt(top10, big, 10)).toBeCloseTo(0.25); // the ceiling of plain recall@10 with R = 40
    expect(normalizedRecallAt(top10, big, 10)).toBe(1);
    expect(normalizedRecallAt(ranked, rel, 10)).toBeCloseTo(2 / 3);
  });
  it("R-precision is precision at R", () => {
    expect(rPrecision(ranked, rel)).toBeCloseTo(1 / 3); // top 3 = 7, 3, 9
  });
  it("reciprocal rank of the first relevant result, 0 if none", () => {
    expect(reciprocalRank(ranked, rel)).toBe(1 / 2);
    expect(reciprocalRank(ranked, new Set([42]))).toBe(0);
  });
  it("mean", () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBe(0);
  });
});

describe("tie-breaking", () => {
  const ids = Array.from({ length: 200 }, (_, i) => i + 1);
  it("is deterministic and independent of the input order", () => {
    expect([...tieBreakOrder(ids, 7)]).toEqual([...tieBreakOrder([...ids].reverse(), 7)]);
  });
  it("is a permutation, differs by seed, and does not follow incident id", () => {
    const a = rankByScore(ids, () => 0, tieBreakOrder(ids, 7));
    expect([...a].sort((x, y) => x - y)).toEqual(ids);
    expect(a).not.toEqual(ids);
    expect(a).not.toEqual(rankByScore(ids, () => 0, tieBreakOrder(ids, 8)));
    // Low ids must not cluster at the top: the mean id of the top 50 stays near the overall mean of 100.5.
    expect(Math.abs(mean(a.slice(0, 50)) - 100.5)).toBeLessThan(25);
  });
  it("only orders equal scores: a higher score still wins", () => {
    const s: Record<number, number> = { 5: 0.5, 2: 0.9, 9: 0.5, 1: 0 };
    const r = rankByScore([9, 1, 5, 2], (id) => s[id]!, tieBreakOrder([1, 2, 5, 9], 3));
    expect(r[0]).toBe(2);
    expect(r[3]).toBe(1);
  });
});

describe("sign test (exact binomial, hand-computed)", () => {
  it("5 wins and no losses: p = 2 * (1/2)^5", () => {
    expect(signTest([1, 1, 1, 1, 1])).toEqual({ better: 5, equal: 0, worse: 0, p: 0.0625 });
  });
  it("7 wins, 3 losses: p = 2 * 176/1024 = 0.34375; ties are dropped", () => {
    const r = signTest([...Array(7).fill(0.2), ...Array(3).fill(-0.2), 0, 0]);
    expect(r).toMatchObject({ better: 7, worse: 3, equal: 2 });
    expect(r.p).toBeCloseTo(0.34375);
  });
  it("all ties (hybrid = vector on text-only queries): p = 1, no signal claimed", () => {
    expect(signTest([0, 0, 0])).toEqual({ better: 0, equal: 3, worse: 0, p: 1 });
  });
  it("is symmetric and never exceeds 1", () => {
    expect(signTest([1, -1])).toMatchObject({ p: 1 });
    expect(signTest([-1, -1, -1, -1, -1]).p).toBe(0.0625);
  });
});
