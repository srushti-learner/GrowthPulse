import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openStore } from "./database.js";
import { createResearchAgent } from "./research-agent.js";
import { createTavilySearch } from "./tavily-mcp.js";
import { createAnalysisWorker } from "./analysis-worker.js";
import { createProductAnalyst } from "./product-intelligence.js";

const config = loadConfig();
if (config.NODE_ENV === "production") {
  throw new Error("Production deployment is not enabled for this local SQLite checkpoint. Configure and verify the planned GoDaddy MySQL storage before deployment.");
}
const store = openStore(config.SQLITE_PATH);
const agent = createResearchAgent({
  apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL,
  search: createTavilySearch({ apiKey: config.TAVILY_API_KEY }),
});
const productAnalyst = createProductAnalyst({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANTHROPIC_MODEL });
const app = createApp({ store, origin: config.APP_ORIGIN, agent, productAnalyst });
const worker = createAnalysisWorker({ store, agent });
const server = app.listen(config.PORT, () => {
  worker.start();
  console.log(`GrowthPulse API listening on port ${config.PORT} (${config.NODE_ENV})`);
});
let closing = false;

server.on("error", (error) => {
  if (!closing) {
    closing = true;
    void Promise.all([worker.stop(), app.stopMarketplace()]).catch((error: unknown) => {
      console.error("Unable to stop analysis worker:", error instanceof Error ? error.name : "unknown");
    }).finally(() => store.close());
  }
  console.error("Unable to start GrowthPulse:", error);
  process.exitCode = 1;
});

async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await Promise.all([worker.stop(), app.stopMarketplace()]);
    server.close((error) => {
      store.close();
      if (error) { console.error("Unable to shut down GrowthPulse cleanly:", error); process.exitCode = 1; }
    });
    server.closeIdleConnections();
  } catch (error) {
    console.error("Unable to stop analysis worker:", error instanceof Error ? error.name : "unknown");
    process.exitCode = 1;
    server.closeAllConnections(); server.close(); store.close();
  }
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
