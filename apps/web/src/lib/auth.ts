import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

/**
 * Single-user session auth (T0.6). The "password" is `APP_AUTH_SECRET`; a
 * successful login stores an HMAC-derived opaque token in an HttpOnly cookie,
 * which is re-derived and constant-time-compared on every protected request.
 * No numbers, orders, or trades touch this path — it only gates the dashboard.
 */

export const SESSION_COOKIE = "trading_session";
const SESSION_PAYLOAD = "trading-app-session-v1";

function secret(): string {
  const value = process.env.APP_AUTH_SECRET;
  if (!value || value.length === 0) {
    throw new Error("APP_AUTH_SECRET is not set");
  }
  return value;
}

/** Opaque session token derived from the secret (not the secret itself). */
export function sessionToken(): string {
  return createHmac("sha256", secret())
    .update(SESSION_PAYLOAD)
    .digest("base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the submitted login secret matches `APP_AUTH_SECRET`. */
export function verifyPassword(input: string): boolean {
  return constantTimeEqual(input, secret());
}

/** True when the current request carries a valid session cookie. */
export async function isAuthenticated(): Promise<boolean> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (!value) return false;
  return constantTimeEqual(value, sessionToken());
}

/** Redirect to /login unless the request is authenticated. */
export async function requireAuth(): Promise<void> {
  if (!(await isAuthenticated())) redirect("/login");
}
