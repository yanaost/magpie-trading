"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { io, type Socket } from "socket.io-client";

interface HealthReport {
  status: "ok" | "degraded" | "down" | string;
  timestamp?: string;
  deps?: Record<string, string>;
}

function toneFor(state: string | undefined): string {
  if (state === "up" || state === "ok") return "up";
  if (state === "degraded") return "degraded";
  return "down";
}

/**
 * Subscribes to the API's `health` WebSocket channel and renders the live
 * gateway/dependency status (T0.6 AC: "page reflects live /healthz over
 * WebSocket"). Falls back to a disconnected badge until the first push.
 */
export default function LiveStatus({ apiUrl }: { apiUrl: string }): ReactNode {
  const [socketUp, setSocketUp] = useState(false);
  const [health, setHealth] = useState<HealthReport | null>(null);

  useEffect(() => {
    const socket: Socket = io(apiUrl, { transports: ["websocket"] });
    socket.on("connect", () => setSocketUp(true));
    socket.on("disconnect", () => setSocketUp(false));
    socket.on("health", (payload: HealthReport) => setHealth(payload));
    return () => {
      socket.close();
    };
  }, [apiUrl]);

  const deps = health?.deps ?? {};

  return (
    <div className="panel">
      <div className="row">
        <span className="badge">
          <span className={`dot ${socketUp ? "up" : "down"}`} />
          WebSocket {socketUp ? "connected" : "offline"}
        </span>
        {health ? (
          <span className="badge">
            <span className={`dot ${toneFor(health.status)}`} />
            system {health.status}
          </span>
        ) : (
          <span className="muted">waiting for first health push…</span>
        )}
      </div>

      {Object.keys(deps).length > 0 ? (
        <div className="row" style={{ marginTop: "0.75rem" }}>
          {Object.entries(deps).map(([name, state]) => (
            <span className="badge" key={name}>
              <span className={`dot ${toneFor(state)}`} />
              {name}: {state}
            </span>
          ))}
        </div>
      ) : null}

      {health?.timestamp ? (
        <div className="muted" style={{ marginTop: "0.75rem" }}>
          updated {new Date(health.timestamp).toLocaleTimeString()}
        </div>
      ) : null}
    </div>
  );
}
