import "reflect-metadata";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

// Load .env from the repo root before anything reads process.env. Resolve the
// path from this module's location (apps/api/{src,dist}) rather than the cwd,
// so `pnpm --filter @magpie/api dev` (cwd = apps/api) still finds the root file.
loadDotenv({
  path: resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config/env.schema.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // The dashboard (apps/web) runs on a different origin and connects over WS.
  app.enableCors({ origin: true, credentials: true });

  // Route Nest's logger through pino.
  app.useLogger(app.get(PinoLogger));

  // Ensure OnModuleDestroy hooks (db/redis cleanup) fire on SIGTERM/SIGINT.
  app.enableShutdownHooks();

  const config = loadConfig();
  await app.listen(config.PORT);

  const logger = app.get(PinoLogger);
  logger.log(`API listening on http://localhost:${config.PORT}`);
  logger.log(`Health: http://localhost:${config.PORT}/healthz`);
}

bootstrap().catch((err) => {
  // Config/boot failures must be loud and fatal.
  console.error("Fatal: failed to bootstrap API", err);
  process.exit(1);
});
