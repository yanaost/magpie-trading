import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}): Promise<ReactNode> {
  if (await isAuthenticated()) redirect("/");
  const { error } = await searchParams;

  return (
    <div className="login-wrap">
      <div className="panel login-card">
        <h1>AI Trading</h1>
        <p className="muted">Enter the access secret to continue.</p>
        <form method="post" action="/api/login">
          <input
            type="password"
            name="secret"
            placeholder="Access secret"
            autoComplete="current-password"
            autoFocus
            required
          />
          {error ? <div className="error">Invalid secret. Try again.</div> : null}
          <button type="submit">Sign in</button>
        </form>
      </div>
    </div>
  );
}
