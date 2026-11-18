import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openStore } from "./database.js";
import { createResearchAgent } from "./research-agent.js";
import { createTavilySearch } from "./tavily-mcp.js";
import { createAnalysisWorker } from "./analysis-worker.js";
import { createProductAnalyst } from "./product-intelligence.js";
import { openMysqlStore } from "./mysql-store.js";

async function main() {
  const config = loadConfig();
  const store = config.mysql ? await openMysqlStore(config.mysql) : openStore(config.SQLITE_PATH);
  try {
    const agent = createResearchAgent({
      apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL,
      search: createTavilySearch({ apiKey: config.TAVILY_API_KEY }),
    });
    const productAnalyst = createProductAnalyst({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL });
    const app = createApp({
      store, origin: config.APP_ORIGIN, agent, productAnalyst,
      production: config.NODE_ENV === "production", trustProxyHops: config.TRUST_PROXY_HOPS,
    });
    const worker = createAnalysisWorker({ store, agent });
    const server = app.listen(config.PORT, () => {
      worker.start();
      console.log(`GrowthPulse API listening on port ${config.PORT} (${config.NODE_ENV})`);
    });
    let closing = false;

    async function shutdown(closeHttp = true) {
      if (closing) return;
      closing = true;
      const stopped = closeHttp
        ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
        : Promise.resolve();
      server.closeIdleConnections();
      const results = await Promise.allSettled([stopped, worker.stop(), app.stopMarketplace()]);
      for (const result of results) {
        if (result.status !== "rejected") continue;
        console.error("Unable to stop background work:", result.reason instanceof Error ? result.reason.name : "unknown");
        process.exitCode = 1;
      }
      try { await store.close(); }
      catch (error) {
        console.error("Unable to close database:", error instanceof Error ? error.name : "unknown");
        process.exitCode = 1;
      }
    }

    server.on("error", (error) => {
      console.error("Unable to start GrowthPulse:", "code" in error ? error.code : error.name);
      process.exitCode = 1;
      void shutdown(false);
    });
    process.on("SIGTERM", () => { void shutdown(); });
    process.on("SIGINT", () => { void shutdown(); });
  } catch (error) {
    await store.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("GrowthPulse could not start:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
