import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Magpie Trading — Dashboard",
  description: "Single-user control dashboard",
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}): ReactNode {
  return (
    <html lang="en">
      {/*
       * Browser extensions (ColorZilla, Grammarly, etc.) inject attributes onto
       * <body> before React hydrates — e.g. cz-shortcut-listen="true" — which
       * would otherwise trip a hydration mismatch warning. suppressHydrationWarning
       * silences that one-level diff; it does not affect our own markup.
       */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
