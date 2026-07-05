/**
 * Server-side fetch helpers for the trading API. `API_URL` is the server→API
 * base (defaults to the local API); the browser uses `NEXT_PUBLIC_API_URL` for
 * the WebSocket connection (see `LiveStatus`).
 */

const API_URL = process.env.API_URL ?? "http://localhost:3001";

export interface StrategySummary {
  id: string;
  name: string;
  timeframe: string;
  mode: string;
  target: string;
}

export interface CandleCount {
  ticker: string;
  timeframe: string;
  count: number;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`API ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export function fetchStrategies(): Promise<StrategySummary[]> {
  return apiGet<StrategySummary[]>("/api/strategies");
}

export function fetchCandleCounts(): Promise<CandleCount[]> {
  return apiGet<CandleCount[]>("/api/candles/counts");
}
