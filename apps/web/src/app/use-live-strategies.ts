"use client";

import { useCallback, useEffect, useState } from "react";
import type { StrategySummary } from "@/lib/api";
import { BROWSER_API_URL, getStrategies } from "@/lib/browser-api";
import { io, type Socket } from "socket.io-client";

export interface LiveStrategies {
  strategies: StrategySummary[];
  /** Optimistically merge one edited summary so chips update before the refetch. */
  applyChange: (updated: StrategySummary) => void;
}

/**
 * Live strategy roster (spec §U3). Seeds from the SSR snapshot, then keeps
 * mode/target current three ways so the chips never lie about state:
 *   - a push on the `strategies` WS channel (any mode/target edit, from this or
 *     another browser tab) triggers an immediate re-fetch;
 *   - a push on the `alerts` channel (a kill-switch trip demotes every strategy
 *     to WATCH) does the same — the demotion must be visible instantly;
 *   - a 10s poll + refetch on window focus as a backstop if a push is missed.
 *
 * A shared hook so the tab strip and the global header summary read one
 * consistent roster.
 */
export function useLiveStrategies(initial: StrategySummary[]): LiveStrategies {
  const [roster, setRoster] = useState(initial);

  const applyChange = useCallback((updated: StrategySummary): void => {
    setRoster((prev) =>
      prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
    );
  }, []);

  useEffect(() => {
    let live = true;
    const sync = (): void => {
      if (document.visibilityState === "hidden") return;
      getStrategies()
        .then((next) => {
          if (live) setRoster(next);
        })
        .catch(() => {
          /* transient API blip — keep the last known roster */
        });
    };

    const socket: Socket = io(BROWSER_API_URL, { transports: ["websocket"] });
    // Any mode/target change or kill-switch trip → re-pull the authoritative roster.
    socket.on("strategies", () => sync());
    socket.on("alerts", () => sync());

    const interval = setInterval(sync, 10_000);
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      live = false;
      socket.close();
      clearInterval(interval);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  return { strategies: roster, applyChange };
}
