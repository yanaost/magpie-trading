import { Global, Module } from "@nestjs/common";
import { APP_CONFIG, loadConfig, type AppConfig } from "./env.schema.js";

/**
 * Global config module. Validates the environment once and exposes the frozen
 * {@link AppConfig} under the {@link APP_CONFIG} token for injection anywhere.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: (): AppConfig => loadConfig(),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
