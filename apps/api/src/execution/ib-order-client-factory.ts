import { createRequire } from "node:module";
import type { IbOrderApi, IbOrderApiFactory } from "./ib-order-gateway.js";

/**
 * Builds a real `@stoqey/ib` client for the order side, mirroring the
 * market-data {@link import("../market-data/ib-client-factory.js").createIbClient}.
 * `@stoqey/ib` is CommonJS, loaded via `createRequire`; constructing an `IBApi`
 * opens no socket — nothing connects until `client.connect()` runs.
 */
interface IbModule {
  IBApi: new (options: {
    host?: string;
    port?: number;
    clientId?: number;
  }) => unknown;
}

const require = createRequire(import.meta.url);

export const createIbOrderApi: IbOrderApiFactory = (opts): IbOrderApi => {
  const { IBApi } = require("@stoqey/ib") as IbModule;
  const client = new IBApi({
    host: opts.host,
    port: opts.port,
    clientId: opts.clientId,
  });
  return client as unknown as IbOrderApi;
};
