import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionToken, verifyPassword } from "@/lib/auth";

const SEVEN_DAYS = 60 * 60 * 24 * 7;

/** Validate the submitted secret and, on success, set the session cookie. */
export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const secret = String(form.get("secret") ?? "");

  if (!verifyPassword(secret)) {
    return NextResponse.redirect(new URL("/login?error=1", req.url), 303);
  }

  const res = NextResponse.redirect(new URL("/", req.url), 303);
  res.cookies.set(SESSION_COOKIE, sessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SEVEN_DAYS,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
