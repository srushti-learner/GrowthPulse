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
  DATABASE_CLIENT: z.enum(["sqlite", "mysql"]).default("sqlite"),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_MODEL: z.string().trim().min(1).default("claude-haiku-4-5"),
  TAVILY_API_KEY: z.string().trim().min(1).optional(),
});

const mysqlSchema = z.object({
  DB_HOST: z.string().trim().min(1),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
  DB_NAME: z.string().trim().min(1).max(64),
  DB_USER: z.string().trim().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_SSL_MODE: z.enum(["required", "disabled"]).default("required"),
  DB_SSL_CA: z.string().min(1).optional(),
});
export type MysqlSettings = z.infer<typeof mysqlSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const result = environmentSchema.safeParse({
    ...environment,
    DATABASE_CLIENT: environment.DATABASE_CLIENT ?? (environment.NODE_ENV === "production" ? "mysql" : "sqlite"),
  });

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }

  const config = result.data;
  if (config.NODE_ENV === "production") {
    if (config.DATABASE_CLIENT !== "mysql") throw new Error("Production requires MySQL; SQLite is local development only.");
    if (!environment.APP_ORIGIN || new URL(config.APP_ORIGIN).protocol !== "https:") {
      throw new Error("Production APP_ORIGIN must be the explicit HTTPS origin of this app.");
    }
  }
  const mysql = config.DATABASE_CLIENT === "mysql" ? mysqlSchema.safeParse(environment) : undefined;
  if (mysql && !mysql.success) {
    throw new Error(`Invalid MySQL configuration: ${mysql.error.issues.map((issue) => issue.path.join(".")).join(", ")}. GoDaddy injects DB_* settings when its hosted database is attached.`);
  }
  return { ...config, mysql: mysql?.success ? mysql.data : undefined };
}
