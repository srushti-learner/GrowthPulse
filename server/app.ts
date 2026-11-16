import express, { type ErrorRequestHandler } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultClientDirectory = fileURLToPath(new URL("../client/", import.meta.url));

export function createApp(options: { production?: boolean; clientDirectory?: string } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok", service: "growthpulse-api" });
  });

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
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ error: "Invalid JSON request body" });
      return;
    }
    if (error instanceof Error && "status" in error && error.status === 413) {
      response.status(413).json({ error: "Request body is too large" });
      return;
    }
    console.error("Request failed:", error);
    response.status(500).json({ error: "An unexpected server error occurred" });
  };
  app.use(handleError);

  return app;
}
