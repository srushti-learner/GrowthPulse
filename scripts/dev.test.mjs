import { afterEach, describe, expect, it } from "vitest";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gp-launcher-"));
  directories.push(directory);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "dist/server"), { recursive: true });
  const launcher = join(directory, "scripts/dev.mjs");
  copyFileSync(new URL("./dev.mjs", import.meta.url), launcher);
  writeFileSync(join(directory, "package.json"), '{"type":"module"}');
  writeFileSync(join(directory, "npm.mjs"), `
    import { appendFileSync } from "node:fs";
    const task = process.argv[3];
    appendFileSync(process.env.TEST_LOG, JSON.stringify({ task, mode: process.env.NODE_ENV, port: process.env.PORT }) + "\\n");
    process.exit(task === "build" ? Number(process.env.TEST_BUILD_EXIT || 0) : 0);
  `);
  writeFileSync(join(directory, "dist/server/index.js"), `
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.TEST_LOG, JSON.stringify({ task: "server", mode: process.env.NODE_ENV, port: process.env.PORT }) + "\\n");
    if (process.env.TEST_WAIT) {
      process.on("SIGTERM", () => {
        appendFileSync(process.env.TEST_LOG, JSON.stringify({ task: "shutdown" }) + "\\n");
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      console.log("fixture-ready");
    } else process.exit(Number(process.env.TEST_SERVER_EXIT || 0));
  `);
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: "development",
    PORT: "3002",
    npm_execpath: join(directory, "npm.mjs"),
    TEST_LOG: join(directory, "events.jsonl"),
    ...settings,
  };
  const events = () => readFileSync(env.TEST_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { directory, launcher, env, events };
}

describe("development and hosted launcher", () => {
  it("keeps local development local even with a custom port or local .env database", async () => {
    const app = fixture();
    writeFileSync(join(app.directory, ".env"), "NODE_ENV=production\nDB_HOST=local-db.example\n");
    await execute(process.execPath, [app.launcher], { env: app.env });
    expect(app.events()).toEqual([{ task: "dev:local", mode: "development", port: "3002" }]);
  });

  it.each([
    { NODE_ENV: "production" },
    { NODE_ENV: "development", DB_HOST: "attached-db.example" },
    { NODE_ENV: "development", DB_HOST: "" },
  ])("builds and starts only the production server for hosted settings %j", async (settings) => {
    const app = fixture({ ...settings, PORT: "8080" });
    await execute(process.execPath, [app.launcher], { env: app.env });
    expect(app.events()).toEqual([
      { task: "build", mode: "production", port: "8080" },
      { task: "server", mode: "production", port: "8080" },
    ]);
  });

  it("preserves a build failure without starting a server or falling back to Vite", async () => {
    const app = fixture({ NODE_ENV: "production", TEST_BUILD_EXIT: "7" });
    await expect(execute(process.execPath, [app.launcher], { env: app.env })).rejects.toMatchObject({ code: 7 });
    expect(app.events()).toEqual([{ task: "build", mode: "production", port: "3002" }]);
  });

  it("preserves a production startup failure without retrying", async () => {
    const app = fixture({ NODE_ENV: "production", TEST_SERVER_EXIT: "9" });
    await expect(execute(process.execPath, [app.launcher], { env: app.env })).rejects.toMatchObject({ code: 9 });
    expect(app.events().map((event) => event.task)).toEqual(["build", "server"]);
  });

  it("forwards hosting shutdown to the running server", async () => {
    const app = fixture({ NODE_ENV: "production", TEST_WAIT: "1" });
    const processHandle = spawn(process.execPath, [app.launcher], { env: app.env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      await new Promise((resolve, reject) => {
        processHandle.on("error", reject);
        processHandle.stdout.on("data", (chunk) => {
          if (chunk.toString().includes("fixture-ready")) resolve();
        });
        processHandle.once("exit", () => reject(new Error("Launcher exited before the server was ready")));
      });
      const finished = once(processHandle, "exit");
      processHandle.kill("SIGTERM");
      expect(await finished).toEqual([143, null]);
      expect(app.events().map((event) => event.task)).toEqual(["build", "server", "shutdown"]);
    } finally {
      if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill("SIGTERM");
    }
  });
});
