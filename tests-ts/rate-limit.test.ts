import { describe, expect, it } from "vitest";
import { rateLimitBucket, requestClientKey } from "../src/worker/rate-limit";

describe("rate limiting", () => {
  it("groups requests into fixed UTC windows", () => {
    expect(rateLimitBucket(60_999, 60)).toBe(60_000);
    expect(rateLimitBucket(120_000, 60)).toBe(120_000);
  });

  it("hashes the Cloudflare supplied client address before persistence", async () => {
    const request = new Request("https://example.com", { headers: { "cf-connecting-ip": "203.0.113.7" } });
    const key = await requestClientKey(request, "test-pepper");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("203.0.113.7");
    expect(await requestClientKey(request, "test-pepper")).toBe(key);
  });

  it("uses a deterministic hashed local key when Cloudflare headers are absent", async () => {
    const first = await requestClientKey(new Request("http://localhost"), "test-pepper");
    expect(await requestClientKey(new Request("http://localhost"), "test-pepper")).toBe(first);
  });
});
