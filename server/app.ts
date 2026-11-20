import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { ApiError, createApi } from "./api.js";
import { EmailUnavailable, PreviewError, UnderstandingError, type Store } from "./database.js";
import { ScanError } from "./public-http.js";
import type { WebsiteScanner } from "./website-scanner.js";
import { CatalogueError } from "./catalogue-store.js";
import { AgentError, type BusinessAgent } from "./business-agent.js";
import { AnalysisError } from "./analysis-store.js";
import { GrowthError } from "./growth-store.js";
import type { ProductAnalyst } from "./product-intelligence.js";
import { SalesError } from "./sales-imports.js";
import type { ContactSender } from "./contact.js";

const defaultClientDirectory = fileURLToPath(new URL("../client/", import.meta.url));

export function createApp(options: { store: Store; origin?: string; production?: boolean; trustProxyHops?: number; clientDirectory?: string; scanner?: WebsiteScanner; agent?: BusinessAgent; productAnalyst?: ProductAnalyst; contactSender?: ContactSender }) {
  const app = express();
  app.disable("x-powered-by");
  if (options.trustProxyHops) app.set("trust proxy", options.trustProxyHops);
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", async (_request, response) => {
    await options.store.checkHealth();
    response.set("Cache-Control", "no-store").json({ status: "ok", service: "growthpulse-api", database: { engine: options.store.engine, status: "ok" } });
  });

  const api = createApi(options.store, options.origin ?? "http://127.0.0.1:5173", options.production ?? false, options.scanner, options.agent, options.productAnalyst, options.contactSender);
  app.use("/api", api);

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: "API endpoint not found" });
  });

  if (options.production) {
    const clientDirectory = options.clientDirectory ?? defaultClientDirectory;
    const indexPath = resolve(clientDirectory, "index.html");
    if (!existsSync(indexPath)) {
      throw new Error("Frontend build is missing. Run npm run build before npm start.");
    }

    app.use(express.static(clientDirectory, { index: false }));
    app.get("/{*path}", (request, response, next) => {
      if (!request.accepts("html") || request.path.startsWith("/assets/")) {
        next();
        return;
      }
      response.sendFile(indexPath);
    });
  }

  app.use((_request, response) => {
    response.status(404).json({ error: "Resource not found" });
  });

  const handleError: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    function sendError(status: number, body: { error: string; issues?: { path: string; message: string }[] }) {
      if (!response.headersSent) response.status(status).json(body);
      else if (!response.destroyed && response.get("Content-Type")?.startsWith("application/x-ndjson")) {
        response.end(`${JSON.stringify({ type: "error", status, message: body.error })}\n`);
      } else response.destroy();
    }
    if (error instanceof ZodError) {
      sendError(400, { error: "Invalid request.", issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) });
      return;
    }
    if (error instanceof ApiError || error instanceof CatalogueError || error instanceof AgentError || error instanceof UnderstandingError || error instanceof PreviewError || error instanceof AnalysisError || error instanceof GrowthError || error instanceof SalesError) {
      sendError(error.status, { error: error.message });
      return;
    }
    if (error instanceof ScanError) {
      sendError(400, { error: error.message });
      return;
    }
    if (error instanceof EmailUnavailable) {
      sendError(409, { error: "An account with that email already exists. Please log in." });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      sendError(400, { error: "Invalid JSON request body" });
      return;
    }
    if (error instanceof Error && "status" in error && error.status === 413) {
      sendError(413, { error: "Request body is too large" });
      return;
    }
    console.error("Request failed:", error instanceof Error ? error.name : "unknown");
    sendError(500, { error: "An unexpected server error occurred" });
  };
  app.use(handleError);

  return Object.assign(app, { stopMarketplace: () => api.stopMarketplace() });
}
