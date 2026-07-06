#!/usr/bin/env bash
#
# Encrypted off-box Postgres backup (T3.6).
#
# Dumps the trading database in Postgres custom format, gzips it, encrypts it
# with AES-256 (openssl, pbkdf2), and drops the artifact in $BACKUP_DIR. An
# optional off-box push (rclone / scp) ships it to storage the VPS itself does
# not control, so a lost box is recoverable. Restore with restore.sh.
#
# The encryption passphrase never touches disk or the process list: it is read
# from $BACKUP_PASSPHRASE (env) or $BACKUP_PASSPHRASE_FILE (a root-only file).
# Losing it means losing the backups — store it in a password manager, NOT in
# this repo or on the VPS.
#
# Cron (nightly 03:15, outside US market hours and the IB restart window):
#   15 3 * * *  BACKUP_PASSPHRASE_FILE=/root/.pgbackup.key \
#               /opt/magpie/infra/backup/pg_backup.sh >> /var/log/pgbackup.log 2>&1
#
# Env:
#   DATABASE_URL           postgres://user:pass@host:port/db   (required)
#   BACKUP_DIR             output dir            (default /var/backups/magpie)
#   BACKUP_PASSPHRASE      encryption secret     (or BACKUP_PASSPHRASE_FILE)
#   BACKUP_PASSPHRASE_FILE file holding the secret
#   BACKUP_RETENTION_DAYS  prune older files     (default 14)
#   BACKUP_REMOTE          rclone/scp target     (optional; e.g. b2:magpie-backups)
set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/magpie}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

# --- resolve the passphrase (env wins; else file) ---------------------------
if [[ -z "${BACKUP_PASSPHRASE:-}" ]]; then
  if [[ -n "${BACKUP_PASSPHRASE_FILE:-}" && -r "${BACKUP_PASSPHRASE_FILE}" ]]; then
    BACKUP_PASSPHRASE="$(cat "${BACKUP_PASSPHRASE_FILE}")"
  else
    echo "FATAL: set BACKUP_PASSPHRASE or a readable BACKUP_PASSPHRASE_FILE" >&2
    exit 1
  fi
fi

mkdir -p "${BACKUP_DIR}"
# Timestamp is passed by the caller in tests for determinism; else now (UTC).
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
OUT="${BACKUP_DIR}/trading-${STAMP}.dump.gz.enc"
TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

echo "[pg_backup] dumping ${DATABASE_URL%%\?*} → ${OUT}"
# -Fc custom format (compressed, selective restore); pipe through gzip for a
# second pass then AES-256. Passphrase handed to openssl via an env var, never
# argv, so it is invisible to `ps`.
pg_dump --format=custom --no-owner --no-privileges "${DATABASE_URL}" \
  | gzip -9 \
  | BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE}" openssl enc -aes-256-cbc -pbkdf2 \
      -salt -pass env:BACKUP_PASSPHRASE -out "${OUT}"

BYTES="$(wc -c <"${OUT}" | tr -d ' ')"
echo "[pg_backup] wrote ${OUT} (${BYTES} bytes)"

if [[ "${BYTES}" -lt 100 ]]; then
  echo "FATAL: backup suspiciously small (${BYTES} bytes) — aborting" >&2
  exit 1
fi

# --- off-box push (optional) ------------------------------------------------
if [[ -n "${BACKUP_REMOTE:-}" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    echo "[pg_backup] rclone copy → ${BACKUP_REMOTE}"
    rclone copy "${OUT}" "${BACKUP_REMOTE}"
  else
    echo "[pg_backup] scp → ${BACKUP_REMOTE}"
    scp "${OUT}" "${BACKUP_REMOTE}"
  fi
fi

# --- retention prune --------------------------------------------------------
find "${BACKUP_DIR}" -name 'trading-*.dump.gz.enc' -type f \
  -mtime "+${RETENTION_DAYS}" -print -delete || true

echo "[pg_backup] done"
