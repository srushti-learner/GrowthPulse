import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = createApp({ production: config.NODE_ENV === "production" });
const server = app.listen(config.PORT, () => {
  console.log(`GrowthPulse API listening on port ${config.PORT} (${config.NODE_ENV})`);
});

server.on("error", (error) => {
  console.error("Unable to start GrowthPulse:", error);
  process.exitCode = 1;
});

function shutdown() {
  server.close((error) => {
    if (error) {
      console.error("Unable to shut down GrowthPulse cleanly:", error);
      process.exitCode = 1;
    }
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
