-- Ensure the TimescaleDB extension is available in the `trading` database.
-- The timescale/timescaledb image enables it in the default DB, but we create
-- it explicitly here so the hypertable migration (T0.3) can rely on it.
CREATE EXTENSION IF NOT EXISTS timescaledb;
