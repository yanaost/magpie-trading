import { EventEmitter } from "node:events";
import type { RawHistoricalBar, RawRealtimeBar } from "./types.js";

/**
 * Thin, testable wrapper around a `@stoqey/ib` `IBApi` instance that owns the
 * connect / reconnect lifecycle and normalizes the raw positional event args
 * into the structured shapes the rest of the adapter consumes.
 *
 * The underlying client is created through an injectable factory so the
 * reconnect logic can be unit tested against a fake socket (T0.5 AC:
 * "disconnect/reconnect test passes") without a live gateway.
 */

/** The subset of the `IBApi` surface this adapter uses. */
export interface IbClient {
  connect(clientId?: number): unknown;
  disconnect(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeAllListeners(event?: string): unknown;
  reqHistoricalData(
    reqId: number,
    contract: unknown,
    endDateTime: string,
    durationStr: string,
    barSizeSetting: string,
    whatToShow: string,
    useRTH: number,
    formatDate: number,
    keepUpToDate: boolean,
  ): unknown;
  reqRealTimeBars(
    reqId: number,
    contract: unknown,
    barSize: number,
    whatToShow: string,
    useRTH: boolean,
  ): unknown;
  cancelRealTimeBars(reqId: number): unknown;
}

export type IbClientFactory = (opts: {
  host: string;
  port: number;
  clientId: number;
}) => IbClient;

export interface IbConnectionOptions {
  host: string;
  port: number;
  clientId: number;
  /** First reconnect delay; doubles each failed attempt up to the cap. */
  baseReconnectMs?: number;
  maxReconnectMs?: number;
  factory: IbClientFactory;
  /** Injectable timer so backoff is testable without real time. */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface IbConnectionEvents {
  connected: () => void;
  disconnected: () => void;
  error: (err: { code?: number; message?: string; reqId?: number }) => void;
  historicalData: (reqId: number, bar: RawHistoricalBar) => void;
  historicalEnd: (reqId: number) => void;
  realtimeBar: (reqId: number, bar: RawRealtimeBar) => void;
  nextValidId: (orderId: number) => void;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));

export class IbConnection extends EventEmitter {
  private client: IbClient | null = null;
  private connected = false;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private reconnectTimer: TimerHandle | null = null;

  private readonly host: string;
  private readonly port: number;
  private readonly clientId: number;
  private readonly baseReconnectMs: number;
  private readonly maxReconnectMs: number;
  private readonly factory: IbClientFactory;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;

  constructor(opts: IbConnectionOptions) {
    super();
    this.host = opts.host;
    this.port = opts.port;
    this.clientId = opts.clientId;
    this.baseReconnectMs = opts.baseReconnectMs ?? 1_000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 30_000;
    this.factory = opts.factory;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimer ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.logger = opts.logger ?? console;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Establish the connection and wire event handlers. Idempotent-ish: a second
   * call while connected is a no-op. */
  start(): void {
    this.closedByUser = false;
    this.openClient();
  }

  /** Permanently close the connection and stop reconnecting. */
  stop(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownClient();
    this.connected = false;
  }

  /** The live client, or `null` if not currently connected. */
  raw(): IbClient | null {
    return this.client;
  }

  private openClient(): void {
    this.teardownClient();
    const client = this.factory({
      host: this.host,
      port: this.port,
      clientId: this.clientId,
    });
    this.client = client;

    client.on("connected", () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.logger.log(`[ib] connected ${this.host}:${this.port}`);
      this.emit("connected");
    });

    client.on("disconnected", () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.emit("disconnected");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    client.on("error", (...args: unknown[]) => {
      const [err, code, reqId] = args;
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : String(err);
      this.emit("error", {
        message,
        code: typeof code === "number" ? code : undefined,
        reqId: typeof reqId === "number" ? reqId : undefined,
      });
    });

    client.on("nextValidId", (...args: unknown[]) => {
      this.emit("nextValidId", num(args[0]));
    });

    client.on("historicalData", (...args: unknown[]) => {
      // (reqId, date, open, high, low, close, volume, barCount, WAP, hasGaps)
      const [reqId, date, open, high, low, close, volume] = args;
      if (typeof date === "string" && date.startsWith("finished")) {
        this.emit("historicalEnd", num(reqId));
        return;
      }
      this.emit("historicalData", num(reqId), {
        date: String(date),
        open: num(open),
        high: num(high),
        low: num(low),
        close: num(close),
        volume: num(volume),
      });
    });

    client.on("realtimeBar", (...args: unknown[]) => {
      // (reqId, time, open, high, low, close, volume, wap, count)
      const [reqId, time, open, high, low, close, volume] = args;
      this.emit("realtimeBar", num(reqId), {
        time: num(time),
        open: num(open),
        high: num(high),
        low: num(low),
        close: num(close),
        volume: num(volume),
      });
    });

    try {
      client.connect(this.clientId);
    } catch (err) {
      this.logger.error(`[ib] connect threw: ${String(err)}`);
      if (!this.closedByUser) this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(
      this.maxReconnectMs,
      this.baseReconnectMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.logger.warn(
      `[ib] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.openClient();
    }, delay);
  }

  private teardownClient(): void {
    if (!this.client) return;
    try {
      this.client.removeAllListeners();
      if (this.connected) this.client.disconnect();
    } catch {
      // best-effort teardown
    }
    this.client = null;
  }

  /** For tests: how many reconnect attempts have been scheduled. */
  get attempts(): number {
    return this.reconnectAttempts;
  }
}
