import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export const sessionDuration = 7 * 24 * 60 * 60 * 1000;
export const sessionCookie = "gp_session";
const dummyHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

function derive(password: string, salt: string) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash = dummyHash) {
  const [algorithm, salt, key, extra] = hash.split("$");
  if (algorithm !== "scrypt" || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(key) || extra !== undefined) {
    throw new Error("Unsupported stored password format.");
  }
  return timingSafeEqual(await derive(password, salt), Buffer.from(key, "hex"));
}
export function digestToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newSession() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: digestToken(token), expiresAt: Date.now() + sessionDuration };
}
export function requestTokenHash(request: Request, cookieName = sessionCookie) {
  const token = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? digestToken(token) : undefined;
}
