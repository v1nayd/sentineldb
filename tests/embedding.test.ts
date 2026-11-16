import { describe, expect, it } from "vitest";
import { EMBEDDING_DIM, embedText, embedTexts } from "../src/lib/embedding";

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i]!, 0);

describe("embedding (all-MiniLM-L6-v2, local ONNX)", () => {
  it("returns a 384-d, L2-normalised vector", async () => {
    const { vector } = await embedText("Multiple failed logins from an unfamiliar IP address.");
    expect(vector).toHaveLength(EMBEDDING_DIM);
    expect(Math.sqrt(dot(vector, vector))).toBeCloseTo(1, 5);
  });

  it("is deterministic and independent of batch composition", async () => {
    const a = "Ransom note found on the file share.";
    const b = "An employee reported a phishing email with a fake login page and a very long explanation of what happened next.";
    const alone = (await embedText(a)).vector;
    const batched = (await embedTexts([b, a]))[1]!.vector;
    const again = (await embedText(a)).vector;
    expect(dot(alone, again)).toBeGreaterThan(0.999999);
    expect(dot(alone, batched)).toBeGreaterThan(0.999999);
  });

  it("ranks a paraphrase above an unrelated narrative", async () => {
    const q = (await embedText("Many unsuccessful sign-in attempts hit the VPN from foreign addresses.")).vector;
    const para = (await embedText("Hundreds of failed password attempts against the bastion host from one overseas address.")).vector;
    const other = (await embedText("A storage bucket holding customer exports was left publicly listable.")).vector;
    expect(dot(q, para)).toBeGreaterThan(dot(q, other));
  });

  it("flags inputs longer than the model's 256-token window as truncated, and only those", async () => {
    const short = await embedText("short narrative");
    const long = await embedText(Array.from({ length: 80 }, () => "Suspicious authentication attempt against the VPN gateway.").join(" "));
    expect(short.truncated).toBe(false);
    expect(long.truncated).toBe(true);
  });

  it("rejects empty or whitespace-only narratives instead of embedding noise", async () => {
    await expect(embedText("")).rejects.toThrow(/empty/i);
    await expect(embedText("   \n\t")).rejects.toThrow(/empty/i);
  });
});
