import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTavilySearch as buildSearch } from "./tavily-mcp.js";

const searches: ReturnType<typeof buildSearch>[] = [];
function createTavilySearch(...args: Parameters<typeof buildSearch>) {
  const search = buildSearch(...args);
  searches.push(search);
  return search;
}
afterEach(async () => {
  await Promise.all(searches.splice(0).map((search) => search.close()));
  vi.useRealTimers();
});

const mcp = vi.hoisted(() => ({
  connect: vi.fn(), listTools: vi.fn(), callTool: vi.fn(), close: vi.fn(), transport: vi.fn(), setNotificationHandler: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class { connect = mcp.connect; listTools = mcp.listTools; callTool = mcp.callTool; close = mcp.close; setNotificationHandler = mcp.setNotificationHandler; },
}));
vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class { constructor(...args: unknown[]) { mcp.transport(...args); } },
}));
const results = { results: [
  { title: "Public rival", url: "https://rival.example.org/", content: "Published cotton clothing." },
  { title: "Same site", url: "https://www.rival.example.org/collection", content: "Duplicate domain." },
  { title: "Private", url: "https://127.0.0.1/" },
  { title: "Unsafe path", url: "https://other.example.org/admin" },
] };
const inputSchema = { type: "object", properties: {
  query: { type: "string" }, search_depth: { type: "string", enum: ["basic", "advanced"] },
  max_results: { type: "number", minimum: 5, maximum: 20 }, include_raw_content: { type: "boolean" },
  include_images: { type: "boolean" },
} };
beforeEach(() => {
  vi.resetAllMocks();
  mcp.close.mockResolvedValue(undefined);
  mcp.listTools.mockResolvedValue({ tools: [{ name: "tavily_search", inputSchema }, { name: "tavily_crawl" }] });
  mcp.callTool.mockResolvedValue({ content: [{ type: "text", text: JSON.stringify(results) }] });
});

describe("bounded hosted Tavily MCP search", () => {
  it("can retain distinct listing URLs on the same marketplace with a caller-owned URL policy", async () => {
    const search = createTavilySearch({ call: async () => ({ results: [
      { title: "One", url: "https://market.example.org/products/1?tracking=private" },
      { title: "Two", url: "https://market.example.org/products/2" },
      { title: "Repeat", url: "https://market.example.org/products/1" },
      { title: "Unsafe", url: "https://127.0.0.1/private" },
    ] }) });
    const results = await search.search("products", new AbortController().signal, {
      deduplicateBy: "url", normalizeUrl(input) { const url = new URL(input); url.search = ""; return url.href; },
    });
    expect(results.map((value) => value.url)).toEqual(["https://market.example.org/products/1", "https://market.example.org/products/2"]);
  });
  it.each(["tavily_search", "tavily-search"])("discovers %s, authenticates only to the fixed endpoint and calls basic search only", async (name) => {
    mcp.listTools.mockResolvedValue({ tools: [{ name, inputSchema }, { name: "tavily-crawl" }] });
    const search = createTavilySearch({ apiKey: "test-only-local-key" });
    const candidates = await search.search("public clothing alternatives", new AbortController().signal);
    expect(candidates).toEqual([{ url: "https://rival.example.org/", title: "Public rival", snippet: "Published cotton clothing." }]);
    expect(mcp.transport.mock.calls[0][0].href).toBe("https://mcp.tavily.com/mcp");
    expect(mcp.transport.mock.calls[0][1].requestInit.headers).toEqual({ Authorization: "Bearer test-only-local-key" });
    expect(mcp.transport.mock.calls[0][0].href).not.toContain("test-only");
    expect(mcp.callTool).toHaveBeenCalledWith({ name, arguments: {
      query: "public clothing alternatives", search_depth: "basic", max_results: 5,
      include_raw_content: false, include_images: false,
    } }, undefined, expect.objectContaining({ timeout: 15_000, signal: expect.any(AbortSignal) }));
    expect(mcp.callTool).toHaveBeenCalledOnce();
    expect(mcp.close).not.toHaveBeenCalled();
    await search.close();
    expect(mcp.close).toHaveBeenCalledOnce();
  });

  it("reuses an exclusively leased connection and approved tool contract without caching search results", async () => {
    const search = createTavilySearch({ apiKey: "fixture" });
    for (const query of ["first category", "second category", "third category"]) {
      await search.search(query, new AbortController().signal);
    }
    expect(mcp.connect).toHaveBeenCalledOnce();
    expect(mcp.listTools).toHaveBeenCalledOnce();
    expect(mcp.callTool.mock.calls.map(([input]) => input.arguments.query)).toEqual(["first category", "second category", "third category"]);
    expect(mcp.close).not.toHaveBeenCalled();
    await search.close();
    expect(mcp.close).toHaveBeenCalledOnce();
    await expect(search.search("after shutdown", new AbortController().signal)).rejects.toMatchObject({ code: "search_closed" });
    expect(mcp.callTool).toHaveBeenCalledTimes(3);
  });

  it("isolates concurrent searches so one cancellation cannot close the other's leased connection", async () => {
    const search = createTavilySearch({ apiKey: "fixture" }), cancelled = new AbortController();
    let finish!: () => void;
    mcp.callTool.mockImplementation(async (input, _schema, { signal }: { signal: AbortSignal }) => {
      if (input.arguments.query === "cancel this") {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      } else await new Promise<void>((resolve) => { finish = resolve; });
      return { structuredContent: results, content: [] };
    });
    const first = search.search("cancel this", cancelled.signal);
    const failure = expect(first).rejects.toThrow("fixture cancelled");
    const second = search.search("keep this", new AbortController().signal);
    await vi.waitFor(() => expect(mcp.callTool).toHaveBeenCalledTimes(2));
    cancelled.abort(new Error("fixture cancelled"));
    await failure;
    expect(mcp.connect).toHaveBeenCalledTimes(2);
    expect(mcp.close).toHaveBeenCalledOnce();
    finish();
    await expect(second).resolves.toHaveLength(1);
    expect(mcp.close).toHaveBeenCalledOnce();
    await search.close();
    expect(mcp.close).toHaveBeenCalledTimes(2);
  });

  it("discards a failed connection without replaying the paid call and reconnects only for another explicit search", async () => {
    const search = createTavilySearch({ apiKey: "fixture" });
    mcp.callTool.mockRejectedValueOnce(new Error("transport failure with private details"));
    await expect(search.search("first", new AbortController().signal)).rejects.toMatchObject({ code: "search_failed" });
    expect(mcp.callTool).toHaveBeenCalledOnce();
    expect(mcp.close).toHaveBeenCalledOnce();
    await search.search("second", new AbortController().signal);
    expect(mcp.connect).toHaveBeenCalledTimes(2);
    expect(mcp.listTools).toHaveBeenCalledTimes(2);
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
  });

  it("closes idle clients after thirty seconds without starting more provider work", async () => {
    vi.useFakeTimers();
    const search = createTavilySearch({ apiKey: "fixture" });
    await search.search("first", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(mcp.close).toHaveBeenCalledOnce();
    expect(mcp.callTool).toHaveBeenCalledOnce();
    await search.search("second", new AbortController().signal);
    expect(mcp.connect).toHaveBeenCalledTimes(2);
  });

  it("re-discovers and validates the tool contract after a provider tool-list change", async () => {
    const search = createTavilySearch({ apiKey: "fixture" });
    await search.search("first", new AbortController().signal);
    mcp.setNotificationHandler.mock.calls[0][1]();
    mcp.listTools.mockResolvedValue({ tools: [{ name: "tavily_search", inputSchema: { properties: {
      ...inputSchema.properties, search_depth: { enum: ["advanced"] },
    } } }] });
    await expect(search.search("second", new AbortController().signal)).rejects.toMatchObject({ code: "search_contract" });
    expect(mcp.connect).toHaveBeenCalledTimes(2);
    expect(mcp.listTools).toHaveBeenCalledTimes(2);
    expect(mcp.callTool).toHaveBeenCalledOnce();
  });

  it("supports Tavily's published text format without treating snippets as verified source evidence", async () => {
    mcp.callTool.mockResolvedValue({ content: [{ type: "text", text: [
      "Request ID: fixture", "Detailed Results:", "", "Title: Public rival", "ID: upstream-not-an-evidence-id",
      "URL: https://rival.example.org/", "Content: Published cotton clothing.", "", "Title: Another store",
      "URL: https://second.example.org/", "Content: More public clothing.", "Continuation of an unverified snippet.",
    ].join("\n") }] });
    const candidates = await createTavilySearch({ apiKey: "fixture" }).search("public", new AbortController().signal);
    expect(candidates).toEqual([
      { url: "https://rival.example.org/", title: "Public rival", snippet: "Published cotton clothing." },
      { url: "https://second.example.org/", title: "Another store", snippet: "More public clothing.\nContinuation of an unverified snippet." },
    ]);
  });

  it("fails closed when the provider cannot guarantee the basic search bounds", async () => {
    mcp.listTools.mockResolvedValue({ tools: [{ name: "tavily_search", inputSchema: { properties: {
      ...inputSchema.properties, search_depth: { enum: ["advanced"] },
    } } }] });
    await expect(createTavilySearch({ apiKey: "fixture" }).search("public", new AbortController().signal)).rejects.toMatchObject({ code: "search_contract" });
    expect(mcp.callTool).not.toHaveBeenCalled(); expect(mcp.close).toHaveBeenCalledOnce();
  });

  it("does not connect without a key, or fall back to another research tool", async () => {
    await expect(createTavilySearch().search("public", new AbortController().signal)).rejects.toMatchObject({ code: "search_not_configured" });
    expect(mcp.connect).not.toHaveBeenCalled();
    mcp.listTools.mockResolvedValue({ tools: [{ name: "tavily-crawl" }, { name: "arbitrary_search" }] });
    await expect(createTavilySearch({ apiKey: "fixture" }).search("public", new AbortController().signal)).rejects.toMatchObject({ code: "search_unavailable" });
    expect(mcp.callTool).not.toHaveBeenCalled();
    expect(mcp.close).toHaveBeenCalledOnce();
  });

  it.each([
    [{ isError: true, content: [{ type: "text", text: "credit limit: test-only-local-key" }] }, "search_rejected"],
    [{ content: [{ type: "text", text: "not JSON" }] }, "search_format"],
    [{ structuredContent: { unknown: [] }, content: [] }, "search_format"],
    [{ structuredContent: { results: [{ title: "x", url: "https://example.org/", content: "x".repeat(132_000) }] }, content: [] }, "search_size"],
  ])("exposes safe failures for rejected, malformed or oversized responses", async (response, code) => {
    mcp.callTool.mockResolvedValue(response);
    const failure = createTavilySearch({ apiKey: "test-only-local-key" }).search("public", new AbortController().signal);
    await expect(failure).rejects.toMatchObject({ code });
    await expect(failure).rejects.not.toThrow("test-only-local-key");
    expect(mcp.close).toHaveBeenCalledOnce();
    expect(mcp.callTool).toHaveBeenCalledOnce();
  });

  it("preserves cancellation and hides raw transport errors without retrying", async () => {
    const controller = new AbortController();
    const reason = new Error("fixture cancellation");
    const call = vi.fn(async (_: Record<string, unknown>, signal: AbortSignal) => {
      controller.abort(reason); signal.throwIfAborted(); return results;
    });
    await expect(createTavilySearch({ call }).search("public", controller.signal)).rejects.toBe(reason);
    expect(call).toHaveBeenCalledOnce();
    mcp.connect.mockRejectedValue(new Error("transport includes test-only-local-key"));
    await expect(createTavilySearch({ apiKey: "test-only-local-key" }).search("public", new AbortController().signal))
      .rejects.toMatchObject({ code: "search_failed", message: expect.not.stringContaining("test-only-local-key") });
    expect(mcp.close).toHaveBeenCalledOnce();
  });
});
