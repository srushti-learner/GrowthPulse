import { openStore } from "./database.js";
import { loadConfig } from "./config.js";
import { openMysqlStore } from "./mysql-store.js";

try {
  const config = loadConfig();
  const store = config.mysql ? await openMysqlStore(config.mysql) : openStore(config.SQLITE_PATH);
  await store.close();
  console.log(`${config.DATABASE_CLIENT} migrations are up to date.`);
} catch (error) {
  console.error("Database migration failed:", error instanceof Error ? error.message : "unknown");
  process.exitCode = 1;
}
