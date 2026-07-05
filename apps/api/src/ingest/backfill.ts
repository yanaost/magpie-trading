import "dotenv/config";
import { createDb } from "@magpie/db";
import { loadConfig } from "../config/env.schema.js";
import { MarketDataService } from "../market-data/market-data.service.js";
import type { DbClient } from "../infra/infra.module.js";

/**
 * Standalone historical backfill CLI.
 *
 *   pnpm --filter @magpie/api ingest:backfill --tickers QUAL,SPHB,SPY --days 400
 *
 * Connects to the IB gateway, requests daily + 5-minute candles for each ticker
 * (rate-limited to respect IB pacing), upserts them into `candles`, and exits.
 */

interface Args {
  tickers: string[];
  days: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tickersRaw = get("--tickers") ?? process.env.MARKET_DATA_TICKERS ?? "";
  const tickers = tickersRaw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
  const days = Number(get("--days") ?? "400");
  if (tickers.length === 0) {
    throw new Error("no tickers: pass --tickers QUAL,SPHB,SPY");
  }
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`invalid --days: ${get("--days")}`);
  }
  return { tickers, days };
}

async function main(): Promise<void> {
  const { tickers, days } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const { db, sql } = createDb(config.DATABASE_URL, { max: 1 });
  const dbClient: DbClient = { db, sql };

  const service = new MarketDataService(config, dbClient);
  console.log(
    `[backfill] connecting ${config.IB_GATEWAY_HOST}:${config.IB_GATEWAY_PORT} …`,
  );
  service.connect();

  try {
    await service.waitUntilConnected(20_000);
    console.log(`[backfill] connected; backfilling ${tickers.join(", ")}`);
    const total = await service.backfill(tickers, days);
    console.log(`[backfill] done: ${total} candles written`);
  } finally {
    service.disconnect();
    await sql.end({ timeout: 5 }).catch(() => undefined);
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`[backfill] failed: ${String(err)}`);
    process.exit(1);
  },
);
