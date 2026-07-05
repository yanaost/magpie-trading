import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

/** Clear the session cookie and return to the login page. */
export async function POST(req: Request): Promise<Response> {
  const res = NextResponse.redirect(new URL("/login", req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
