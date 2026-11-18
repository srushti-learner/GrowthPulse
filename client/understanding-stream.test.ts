import { afterEach, describe, expect, it, vi } from "vitest";
import type { Understanding } from "../shared/understanding";
import { followAnalysisJob, streamUnderstanding } from "./understanding-stream";
import type { AnalysisJob } from "../shared/analysis";

const understanding: Understanding = {
  id: "11111111-1111-4111-8111-111111111111", businessId: "22222222-2222-4222-8222-222222222222",
  scanId: "33333333-3333-4333-8333-333333333333", createdAt: "2026-11-16T12:00:00.000Z",
  scanStatus: "complete", reviewedAt: null, warnings: [], productImportId: null, suggestions: [], briefing: null,
};
const headers = { "Content-Type": "application/x-ndjson" };
const frame = (value: unknown) => `${JSON.stringify(value)}\r\n`;
afterEach(() => vi.unstubAllGlobals());

describe("live understanding protocol", () => {
  it("delivers updates before completion across JSON lines and UTF-8 chunk boundaries", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers }));
    vi.stubGlobal("fetch", fetch);
    const update = vi.fn();
    const result = streamUnderstanding("/analysis", new AbortController().signal, update);
    const preview = { type: "briefing", briefing: { summary: { text: "A caf\u00e9 business" } } };
    const bytes = new TextEncoder().encode(`\r\n${frame({ type: "phase", phase: "analysing" })}${frame(preview)}`);
    const split = bytes.indexOf(0xc3) + 1;
    stream.enqueue(bytes.slice(0, split));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ type: "phase", phase: "analysing" }));
    expect(update).not.toHaveBeenCalledWith(preview);
    stream.enqueue(bytes.slice(split));
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(preview));
    stream.enqueue(new TextEncoder().encode(frame({ type: "complete", understanding })));
    stream.close();
    await expect(result).resolves.toEqual(understanding);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", method: "POST", headers: { Accept: "application/x-ndjson", "Content-Type": "application/json" } });
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  describe("reconnectable analysis transport", () => {
    const job: AnalysisJob = {
      id: "44444444-4444-4444-8444-444444444444", businessId: understanding.businessId,
      requestedUrl: "https://shop.example.com/", scanId: null, status: "queued", phase: "connecting",
      preview: null, understanding: null, error: null, revision: 0,
      createdAt: understanding.createdAt, updatedAt: understanding.createdAt,
    };
    const queued = (value: AnalysisJob, status = 200) => new Response(frame({ type: "job", job: value }), { headers, status });
    const completed: AnalysisJob = { ...job, status: "completed", scanId: understanding.scanId, understanding, revision: 3 };

    it("submits once, reconnects GET streams after EOF, and delivers persisted previews before the final result", async () => {
      const preview = { summary: { text: "A provisional clothing analysis" } };
      const running: AnalysisJob = { ...job, status: "running", phase: "analysing", preview, revision: 2 };
      const fetch = vi.fn().mockResolvedValueOnce(queued(job, 202)).mockResolvedValueOnce(queued(running)).mockResolvedValueOnce(queued(completed));
      vi.stubGlobal("fetch", fetch);
      const update = vi.fn(), onJob = vi.fn();
      const key = "55555555-5555-4555-8555-555555555555";
      await expect(streamUnderstanding("/api/businesses/analysis/understanding", new AbortController().signal, update, undefined, onJob, key)).resolves.toEqual(understanding);
      expect(update).toHaveBeenCalledWith({ type: "briefing", briefing: preview });
      expect(onJob).toHaveBeenLastCalledWith(completed);
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Prefer: "respond-async", "Idempotency-Key": key } });
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ permission: true, research: true, researchVersion: 2 });
      for (const [path, options] of fetch.mock.calls.slice(1)) {
        expect(path).toBe(`/api/businesses/${job.businessId}/analysis-jobs/${job.id}/events`);
        expect(options.method).toBeUndefined(); expect(options.body).toBeUndefined();
      }
      expect(fetch.mock.calls[2][1].signal.aborted).toBe(true);
    });

    it("recovers a transient viewer connection failure using GET only", async () => {
      const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Network unavailable")).mockResolvedValueOnce(queued(completed));
      vi.stubGlobal("fetch", fetch);
      await expect(followAnalysisJob(job, new AbortController().signal, vi.fn())).resolves.toEqual(understanding);
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.every(([, options]) => !options.method && !options.body)).toBe(true);
    });

    it("bounds consecutive connection retries and leaves the job available for later reconnection", async () => {
      vi.useFakeTimers();
      const fetch = vi.fn().mockRejectedValue(new TypeError("Network unavailable"));
      vi.stubGlobal("fetch", fetch);
      try {
        const result = expect(followAnalysisJob(job, new AbortController().signal, vi.fn())).rejects.toMatchObject({
          status: 503, message: expect.stringContaining("It may still be running"),
        });
        await vi.runAllTimersAsync(); await result;
        expect(fetch).toHaveBeenCalledTimes(3);
        expect(fetch.mock.calls.every(([, options]) => !options.method && !options.body)).toBe(true);
      } finally { vi.useRealTimers(); }
    });

    it.each(["failed", "interrupted", "cancelled"] as const)("never automatically retries a %s job", async (status) => {
      const fetch = vi.fn().mockResolvedValueOnce(queued({ ...job, status, error: "Stopped safely. Retry explicitly.", revision: 2 }, 202));
      vi.stubGlobal("fetch", fetch);
      await expect(streamUnderstanding("/analysis", new AbortController().signal, vi.fn())).rejects.toMatchObject({ message: "Stopped safely. Retry explicitly." });
      expect(fetch).toHaveBeenCalledOnce();
    });

    it("aborts only its viewer on navigation, without cancelling or resubmitting background work", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(queued(job, 202)).mockImplementation(async (_path, options) => new Response(new ReadableStream({
        start(controller) { options.signal.addEventListener("abort", () => controller.error(options.signal.reason), { once: true }); },
      }), { headers }));
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      const result = streamUnderstanding("/analysis", controller.signal, vi.fn());
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      controller.abort();
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls.some(([path]) => path.endsWith("/cancel"))).toBe(false);
    });

    it("does not automatically repeat an unacknowledged POST and accepts the same key on an explicit retry", async () => {
      const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Response lost")).mockResolvedValueOnce(queued(completed, 202));
      vi.stubGlobal("fetch", fetch);
      const key = crypto.randomUUID();
      await expect(streamUnderstanding("/analysis", new AbortController().signal, vi.fn(), undefined, undefined, key)).rejects.toThrow("Response lost");
      expect(fetch).toHaveBeenCalledOnce();
      await expect(streamUnderstanding("/analysis", new AbortController().signal, vi.fn(), undefined, undefined, key)).resolves.toEqual(understanding);
      expect(fetch.mock.calls.map(([, options]) => options.headers["Idempotency-Key"])).toEqual([key, key]);
    });

    it("loads an already completed job without network or provider work", async () => {
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      await expect(followAnalysisJob(completed, new AbortController().signal, vi.fn())).resolves.toEqual(understanding);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it.each([
    { body: "{invalid}\n", message: "unreadable update", expectedStatus: 502 },
    { body: frame({ type: "phase", phase: "invented" }), message: "invalid update", expectedStatus: 502 },
    { body: frame({ type: "briefing", briefing: { summary: { text: "Unfinished analysis" } } }), message: "ended before it finished", expectedStatus: 502 },
    { body: frame({ type: "error", status: 401, message: "Please log in to continue." }), message: "Please log in", expectedStatus: 401 },
    { body: `${"x".repeat(512 * 1024 + 1)}\n`, message: "size limit", expectedStatus: 502 },
    { body: "x".repeat(512 * 1024 + 1), message: "size limit", expectedStatus: 502 },
  ])("rejects $message without retrying or returning provisional text as a result", async ({ body, message, expectedStatus }) => {
    const fetch = vi.fn().mockResolvedValue(new Response(body, { headers }));
    vi.stubGlobal("fetch", fetch);
    await expect(streamUnderstanding("/analysis", new AbortController().signal, vi.fn())).rejects.toMatchObject({ status: expectedStatus, message: expect.stringContaining(message) });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("preserves preflight HTTP errors before the stream starts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Scan limit reached." }), { status: 429 })));
    const update = vi.fn();
    await expect(streamUnderstanding("/analysis", new AbortController().signal, update)).rejects.toMatchObject({ status: 429, message: "Scan limit reached." });
    expect(update).not.toHaveBeenCalled();
  });

  it("aborts an active reader when the owner leaves", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, options: RequestInit) => new Response(new ReadableStream({
      start(controller) { options.signal!.addEventListener("abort", () => controller.error(options.signal!.reason), { once: true }); },
    }), { headers })));
    const controller = new AbortController();
    const result = streamUnderstanding("/analysis", controller.signal, vi.fn());
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});
