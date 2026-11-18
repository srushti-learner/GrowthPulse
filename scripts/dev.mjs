import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let child;
let interrupted;
const signalCode = (signal) => signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1;
const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
  const handler = () => {
    interrupted = signal;
    child?.kill(signal);
  };
  process.on(signal, handler);
  return [signal, handler];
});

function run(args, environment) {
  if (interrupted) return Promise.resolve(signalCode(interrupted));
  child = spawn(process.execPath, args, { cwd: root, env: environment, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      child = undefined;
      resolve(interrupted ? signalCode(interrupted) : code ?? signalCode(signal));
    });
  });
}

async function main() {
  try {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error("Run this launcher with npm run dev.");

    // Do not load .env here: local database experiments must remain local by default.
    const hosted = process.env.NODE_ENV === "production" || process.env.DB_HOST !== undefined;
    if (!hosted) return await run([npm, "run", "dev:local"], process.env);

    console.log("Starting hosted GrowthPulse: building the app, then serving it with Express (no Vite development server).");
    const environment = { ...process.env, NODE_ENV: "production" };
    const buildCode = await run([npm, "run", "build"], environment);
    if (buildCode !== 0 || interrupted) return buildCode;
    return await run(["dist/server/index.js"], environment);
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
  }
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error("GrowthPulse launcher could not start:", error.message);
  process.exitCode = 1;
});
