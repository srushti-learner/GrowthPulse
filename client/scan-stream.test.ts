import { afterEach, describe, expect, it, vi } from "vitest";
import { scanWebsite } from "./scan-stream";

afterEach(() => vi.unstubAllGlobals());

describe("bounded website scan updates", () => {
  it.each([
    ["{bad json}\n", "unreadable update", 502],
    [JSON.stringify({ type: "progress", progress: { stage: "invented" } }) + "\n", "invalid update", 502],
    [" ".repeat(4 * 1024 * 1024 + 1), "exceeded the size limit", 502],
    [JSON.stringify({ type: "error", status: 503, message: "Scanner unavailable." }) + "\n", "Scanner unavailable", 503],
  ])("rejects unsuccessful frames without reporting a completed result", async (body, message, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })));
    const progress = vi.fn();
    await expect(scanWebsite("/api/website/scan", { url: "https://shop.example.com", permission: true },
      new AbortController().signal, progress)).rejects.toMatchObject({ status, message: expect.stringContaining(message) });
    expect(progress).not.toHaveBeenCalled();
  });
});
