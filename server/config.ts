import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  APP_ORIGIN: z.url().default("http://127.0.0.1:5173").refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && value === url.origin;
  }, "Use an HTTP(S) origin with no path or trailing slash."),
  SQLITE_PATH: z.string().trim().min(1).default("./data/growthpulse.sqlite"),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-haiku-4-5"),
  TAVILY_API_KEY: z.string().trim().min(1).optional(),
});

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return result.data;
}
