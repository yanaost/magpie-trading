import { createRequire } from "node:module";
import type { IbClient, IbClientFactory } from "./ib-connection.js";

/**
 * Builds a real `@stoqey/ib` client. `@stoqey/ib` ships as CommonJS, so it is
 * loaded via `createRequire` (the standard ESM→CJS bridge) rather than a static
 * import — this keeps named-export interop simple and defers construction until
 * a live connection is actually requested. Constructing an `IBApi` opens no
 * socket; nothing connects until `client.connect()` runs.
 */

interface IbModule {
  IBApi: new (options: {
    host?: string;
    port?: number;
    clientId?: number;
  }) => unknown;
}

const require = createRequire(import.meta.url);

export const createIbClient: IbClientFactory = (opts): IbClient => {
  const { IBApi } = require("@stoqey/ib") as IbModule;
  const client = new IBApi({
    host: opts.host,
    port: opts.port,
    clientId: opts.clientId,
  });
  // `IBApi` structurally satisfies the `IbClient` surface we use.
  return client as unknown as IbClient;
};
