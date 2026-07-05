import { Logger } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

/**
 * WebSocket gateway stub. Channels from spec §8 (`proposals`, `positions`,
 * `fills`, `alerts`, `gateway-status`) are emitted here as the pipeline lands.
 * For Phase 0 it accepts connections and can broadcast `gateway-status`.
 */
@WebSocketGateway({ cors: { origin: true } })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server!: Server;
  private readonly logger = new Logger("EventsGateway");

  handleConnection(client: Socket): void {
    this.logger.log(`ws client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.log(`ws client disconnected: ${client.id}`);
  }

  /** Broadcast a gateway-status update to all connected dashboards. */
  emitGatewayStatus(payload: unknown): void {
    this.server?.emit("gateway-status", payload);
  }

  /** Broadcast a full /healthz report to all connected dashboards. */
  emitHealth(payload: unknown): void {
    this.server?.emit("health", payload);
  }

  /** Broadcast an alert/notification (spec §8 `alerts`) — e.g. kill-switch trips. */
  emitAlert(payload: unknown): void {
    this.server?.emit("alerts", payload);
  }

  /** Broadcast a pending proposal (spec §8 `proposals`) awaiting approval. */
  emitProposal(payload: unknown): void {
    this.server?.emit("proposals", payload);
  }

  /** Broadcast an open-positions snapshot (spec §8 `positions`). */
  emitPositions(payload: unknown): void {
    this.server?.emit("positions", payload);
  }
}
