import { openStore } from "./database.js";
import { loadConfig } from "./config.js";

const store = openStore(loadConfig().SQLITE_PATH);
store.close();
console.log("SQLite migrations are up to date. GoDaddy MySQL migration is a separate future step.");
