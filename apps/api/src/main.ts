import "reflect-metadata";
import { config as loadDotenv } from "dotenv";

// Load .env from the repo root before anything reads process.env.
loadDotenv();

import { NestFactory } from "@nestjs/core";
import { Logger as PinoLogger } from "nestjs-pino";
import { AppModule } from "./app.module.js";
import { loadConfig } from "./config/env.schema.js";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
