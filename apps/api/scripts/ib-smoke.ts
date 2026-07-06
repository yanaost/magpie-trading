/**
 * Manual PAPER integration smoke (T2.1 AC). Connects to a running IB paper
 * gateway, places a tiny bracket (1 share, protective stop well away from the
 * market), reads it back from open orders, then cancels it. Nothing here runs in
 * CI — it needs a live paper gateway (IBKR Gateway/TWS in paper mode).
 *
 * Usage (paper only — never point this at a live account):
 *   IB_GATEWAY_HOST=localhost IB_GATEWAY_PORT=4002 \
 *   pnpm --filter @magpie/api exec tsx scripts/ib-smoke.ts AAPL
 *
 * Requires the paper gateway's API to be enabled and the port to match
 * IB_GATEWAY_PORT (4002 = IB Gateway paper, 7497 = TWS paper).
 */
import { setTimeout as delay } from "node:timers/promises";
import { IbExecutionPort } from "../src/execution/ib-execution-port.js";
import { IbApiOrderGateway } from "../src/execution/ib-order-gateway.js";
import { createIbOrderApi } from "../src/execution/ib-order-client-factory.js";

async function main(): Promise<void> {
  const symbol = process.argv[2] ?? "AAPL";
  const host = process.env.IB_GATEWAY_HOST ?? "localhost";
  const port = Number(process.env.IB_GATEWAY_PORT ?? 4002);
  const clientId = Number(process.env.IB_CLIENT_ID ?? 11);

  const gateway = new IbApiOrderGateway({
    host,
    port,
    clientId,
    factory: createIbOrderApi,
  });
  const execPort = new IbExecutionPort(gateway);

  console.log(`[smoke] connecting to IB paper gateway ${host}:${port}...`);
  await execPort.start();
  console.log("[smoke] connected. Placing a 1-share bracket on", symbol);

  // Stop far below a plausible price so the protective leg never triggers in
  // the seconds this script runs; target far above for the same reason.
  const handle = await execPort.placeBracket({
    strategyId: "smoke",
    target: "PAPER",
    ticker: symbol,
    side: "long",
    qty: 1,
    entryType: "market",
    stopPrice: 1,
    targetPrice: 100_000,
    timeInForce: "DAY",
  });
  console.log("[smoke] bracket placed:", handle.bracketId, {
    parent: handle.parent.orderId,
    stop: handle.stop.orderId,
    target: handle.target?.orderId,
  });

  await delay(2_000);
  const open = await gateway.fetchOpenOrders();
  console.log(`[smoke] broker reports ${open.length} open order(s):`);
  for (const o of open) {
    console.log(
      `  #${o.orderId} ${o.action} ${o.totalQuantity} ${o.symbol} ${o.orderType} ${o.status}`,
    );
  }

  console.log("[smoke] cancelling bracket...");
  await execPort.cancelBracket(handle.bracketId);
  await delay(1_500);
  const afterCancel = await gateway.fetchOpenOrders();
  console.log(
    `[smoke] ${afterCancel.length} open order(s) remain after cancel.`,
  );

  gateway.disconnect();
  console.log("[smoke] done.");
}

main().catch((err: unknown) => {
  console.error("[smoke] failed:", err);
  process.exitCode = 1;
});
