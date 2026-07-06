#!/usr/bin/env bash
#
# Restore an encrypted Postgres backup produced by pg_backup.sh (T3.6).
#
# Decrypts (openssl AES-256), gunzips, and pg_restores into the TARGET database.
# Use this for both real recovery and the periodic restore drill (see
# infra/README.md → "Backup & restore drill"). The drill MUST target a scratch
# database, never the live one.
#
# Usage:
#   BACKUP_PASSPHRASE_FILE=/root/.pgbackup.key \
#   TARGET_DATABASE_URL=postgres://trader:trader@localhost:5432/trading_restore \
#     infra/backup/restore.sh /var/backups/magpie/trading-20260706T031500Z.dump.gz.enc
#
# Env:
#   TARGET_DATABASE_URL    where to restore INTO           (required)
#   BACKUP_PASSPHRASE      decryption secret               (or _FILE)
#   BACKUP_PASSPHRASE_FILE file holding the secret
#   DROP_AND_CREATE        "true" → drop+recreate TARGET db first (drill only)
set -euo pipefail

ENC_FILE="${1:?usage: restore.sh <encrypted-backup-file>}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"

if [[ ! -r "${ENC_FILE}" ]]; then
  echo "FATAL: cannot read backup file: ${ENC_FILE}" >&2
  exit 1
fi

if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" && -r "${BACKUP_PASSPHRASE_FILE}" ]]; then
    BACKUP_PASSPHRASE="$(cat "${BACKUP_PASSPHRASE_FILE}")"
  else
    echo "FATAL: set BACKUP_PASSPHRASE or a readable BACKUP_PASSPHRASE_FILE" >&2
    exit 1
  fi
fi

# --- optionally (re)create the scratch target for a clean drill -------------
if [[ "${DROP_AND_CREATE:-false}" == "true" ]]; then
  # Split the target URL into an admin URL (postgres db) + the target db name.
  DBNAME="$(basename "${TARGET_DATABASE_URL%%\?*}")"
  ADMIN_URL="${TARGET_DATABASE_URL%/*}/postgres"
  echo "[restore] dropping + recreating scratch db '${DBNAME}'"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${DBNAME}\";"
  psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${DBNAME}\";"
fi

echo "[restore] decrypting ${ENC_FILE} → ${TARGET_DATABASE_URL%%\?*}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE}" openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass env:BACKUP_PASSPHRASE -in "${ENC_FILE}" \
  | gunzip \
  | pg_restore --no-owner --no-privileges --clean --if-exists \
      --dbname="${TARGET_DATABASE_URL}"

echo "[restore] done — verify row counts against expectations"
