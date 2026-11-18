import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { publicUrl, ScanError } from "./public-http.js";

export class ResearchToolError extends Error {
  constructor(public code: string, message: string, public paths: string[] = []) { super(message); }
}
const candidateSchema = z.object({
  title: z.string().max(1000), url: z.string().max(2048), content: z.string().max(20_000).optional(),
});
const searchResponseSchema = z.object({ results: z.array(candidateSchema).max(10) });
export type SearchCandidate = { title: string; url: string; snippet: string };
export type TavilyCall = (arguments_: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export type ResearchSearch = ReturnType<typeof createTavilySearch>;

function decodeSearchText(text: string): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  const marker = /^Detailed Results:\s*$/m.exec(text);
  if (!marker) throw new ResearchToolError("search_format", "Tavily returned an unreadable search response.");
  const body = text.slice(marker.index + marker[0].length).trim();
  if (!body) return { results: [] };
  const sections = body.split(/\r?\n\r?\n(?=(?:Title|URL): )/);
  const results = sections.map((section) => {
    const parsed = /^(?:Title: ([^\r\n]*)\r?\n)?(?:ID: [^\r\n]*\r?\n)?URL: ([^\r\n]+)(?:\r?\nContent: ([\s\S]*))?$/.exec(section);
    if (!parsed) throw new ResearchToolError("search_format", "Tavily returned an unsupported formatted search result.");
    return { title: parsed[1] ?? "", url: parsed[2], content: parsed[3] ?? "" };
  });
  return { results };
}

function approvedArguments(inputSchema: unknown, arguments_: Record<string, unknown>) {
  const schema = z.object({ properties: z.record(z.string(), z.record(z.string(), z.unknown())) }).safeParse(inputSchema);
  if (!schema.success) throw new ResearchToolError("search_contract", "Tavily did not publish a supported search input schema.");
  const properties = schema.data.properties;
  if (!["query", "search_depth", "max_results", "include_raw_content"].every((key) => key in properties)
    || (Array.isArray(properties.search_depth.enum) && !properties.search_depth.enum.includes("basic"))
    || (typeof properties.max_results.minimum === "number" && properties.max_results.minimum > 5)
    || (typeof properties.max_results.maximum === "number" && properties.max_results.maximum < 5)) {
    throw new ResearchToolError("search_contract", "Tavily's current tool does not support this application's bounded basic-search contract.");
  }
  return Object.fromEntries(Object.entries(arguments_).filter(([key]) => key in properties));
}

export function createTavilySearch({ apiKey, call }: { apiKey?: string; call?: TavilyCall } = {}) {
  const invoke: TavilyCall = call ?? (async (arguments_, signal) => {
    const client = new Client({ name: "growthpulse-research", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL("https://mcp.tavily.com/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
      const { tools } = await client.listTools({}, { signal, timeout: 15_000 });
      const tool = tools.find(({ name }) => name === "tavily_search" || name === "tavily-search");
      if (!tool) throw new ResearchToolError("search_unavailable", "The Tavily MCP server did not expose its approved search tool.");
      const response = CallToolResultSchema.parse(await client.callTool({
        name: tool.name, arguments: approvedArguments(tool.inputSchema, arguments_),
      }, undefined, { signal, timeout: 15_000 }));
      if (response.isError) throw new ResearchToolError("search_rejected", "Tavily rejected the search. Check its credentials, free-credit balance and rate limits.");
      if (response.structuredContent) return response.structuredContent;
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      if (Buffer.byteLength(text) > 128 * 1024) throw new ResearchToolError("search_size", "Tavily returned more search data than this run permits.");
      return decodeSearchText(text);
    } finally {
      await client.close();
    }
  });
  return {
    configured: !!apiKey || !!call,
    async search(query: string, cancellation: AbortSignal, options: {
      deduplicateBy?: "host" | "url"; normalizeUrl?: (url: string) => string | null;
    } = {}): Promise<SearchCandidate[]> {
      if (!this.configured) throw new ResearchToolError("search_not_configured", "Competitor discovery needs a server-side TAVILY_API_KEY. No search was made.");
      const signal = AbortSignal.any([cancellation, AbortSignal.timeout(20_000)]);
      let raw: unknown;
      try {
        raw = await invoke({
          query: z.string().trim().min(1).max(500).parse(query),
          search_depth: "basic", max_results: 5, auto_parameters: false,
          include_raw_content: false, include_answer: false, include_images: false,
        }, signal);
      } catch (error) {
        cancellation.throwIfAborted();
        if (error instanceof ResearchToolError) throw error;
        throw new ResearchToolError("search_failed", "Tavily search failed or timed out. Check the server-side connection, key and free-credit balance; no automatic retry was made.");
      }
      if (Buffer.byteLength(JSON.stringify(raw)) > 128 * 1024) throw new ResearchToolError("search_size", "Tavily returned more search data than this run permits.");
      const parsed = searchResponseSchema.safeParse(raw);
      if (!parsed.success) throw new ResearchToolError("search_format", "Tavily returned an unsupported search result format.");
      const candidates: SearchCandidate[] = [];
      for (const result of parsed.data.results) {
        let url: URL;
        try {
          const normalized = options.normalizeUrl ? options.normalizeUrl(result.url) : result.url;
          if (!normalized) continue;
          url = publicUrl(normalized);
        }
        catch (error) { if (error instanceof ScanError) continue; throw error; }
        if (candidates.some((candidate) => options.deduplicateBy === "url" ? candidate.url === url.href
          : new URL(candidate.url).hostname.replace(/^www\./, "") === url.hostname.replace(/^www\./, ""))) continue;
        candidates.push({ url: url.href, title: result.title.slice(0, 300), snippet: (result.content ?? "").slice(0, 500) });
      }
      return candidates;
    },
  };
}
