import { z } from "zod";

export class ApiFailure extends Error {
  constructor(public status: number, message: string, public retryAfterSeconds?: number) { super(message); }
}
const errorSchema = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

async function responseJson(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  try { return await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ApiFailure(response.status, response.ok
      ? "The server returned an unexpected response. Please retry."
      : `Request failed (HTTP ${response.status}). Please retry.`);
  }
}

export async function apiResponse(path: string, options: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
  });
  if (!response.ok) {
    const error = errorSchema.safeParse(await responseJson(response));
    const retryAfter = response.headers.get("Retry-After");
    const seconds = retryAfter === null ? undefined : Number(retryAfter);
    throw new ApiFailure(response.status, error.success
      ? error.data.issues?.map((issue) => `${issue.path || "Request"}: ${issue.message}`).join("; ") || error.data.error
      : `Request failed (HTTP ${response.status}).`,
    seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined);
  }
  return response;
}

export async function api<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const response = await apiResponse(path, options, timeoutMs);
  const body = await responseJson(response);
  const result = schema.safeParse(body);
  if (!result.success) throw new Error("The server returned an unexpected response. Please retry.");
  return result.data;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "The request failed. Please retry.";
}
