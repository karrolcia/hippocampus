#!/usr/bin/env bash
# Hippocampus nightly backup (D27).
#
#   VACUUM INTO inside the running container  →  docker cp out  →  tar with manifest
#   + SHA256SUMS  →  GPG-encrypt to TWO public keys  →  keep newest N locally  →
#   mirror offsite (Hetzner Storage Box sub-account, rsync over ssh, port 23).
#
# Runs as root via hippo-backup.service (needs docker). Pattern: AppKeep
# infra/backup/appkeep-backup.sh. Fail loud, fail closed:
#   - every step's exit code and output is checked; a partial bundle is never shipped
#     or allowed to displace a good one in the prune;
#   - offsite deletion is limited to the names this run expires, never a blanket
#     --delete (an empty staging dir on a rebuilt box would wipe the offsite history);
#   - the bundle is durable locally BEFORE the mirror, so a failed mirror costs nothing
#     (it ships on the next run) but still exits non-zero, so the unit shows `failed`;
#   - this box cannot reach the alert sink (not on the tailnet), so a failure here is
#     surfaced by the drill host's daily freshness check (hippo-restore-drill.sh
#     freshness), which alerts when the newest offsite bundle is too old.
#
# Encryption, two layers:
#   1. The database file itself is encrypted by the app (SQLite3MultipleCiphers,
#      ChaCha20, key = HIPPO_PASSPHRASE). VACUUM INTO keeps that encryption.
#   2. The bundle is GPG-encrypted to GPG_RECIPIENTS: a RECOVERY key whose private half
#      lives only in the password manager, and a DRILL key whose private half lives on
#      the drill host. No private key is on this box.
#
# Config: /etc/hippocampus/backup.env (see backup.env.example). Usage:
#   hippo-backup.sh            # the nightly run
#   SNAPSHOT_RUNNER=host …     # tests only: snapshot with host node instead of docker
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG=${BACKUP_CONFIG:-/etc/hippocampus/backup.env}
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"

# printf only, never tee: a tee inside log() under pipefail can end the run silently.
log()  { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
fail() { log "FAIL: $*"; exit 1; }

: "${GPG_RECIPIENTS:?set GPG_RECIPIENTS (space-separated fingerprints: recovery + drill)}"
: "${GNUPGHOME:?set GNUPGHOME (holds the two PUBLIC keys only)}"
: "${BACKUP_STAGING:?set BACKUP_STAGING}"
: "${BACKUP_REMOTE:?set BACKUP_REMOTE (user@host:dir/ or a local path for tests)}"
BACKUP_SSH_PORT=${BACKUP_SSH_PORT:-23}
RETENTION=${RETENTION:-14}
RETENTION_DAYS=${RETENTION_DAYS:-14}
CONTAINER=${CONTAINER:-hippocampus}
SNAPSHOT_RUNNER=${SNAPSHOT_RUNNER:-docker}
export GNUPGHOME

for bin in gpg tar sha256sum rsync; do
  command -v "$bin" >/dev/null || fail "$bin not installed"
done
case "$RETENTION$RETENTION_DAYS" in *[!0-9]*) fail "RETENTION and RETENTION_DAYS must be integers" ;; esac
[ "$RETENTION" -ge 1 ] || fail "RETENTION must be >= 1"

# Every recipient must be a key we hold, or gpg would encrypt to fewer keys than intended
# (it refuses an unknown recipient, but say which one).
n_recipients=0
for r in $GPG_RECIPIENTS; do
  gpg --batch --list-keys "$r" >/dev/null 2>&1 || fail "GPG public key $r not in $GNUPGHOME"
  n_recipients=$((n_recipients + 1))
done
[ "$n_recipients" -ge 2 ] || fail "need two recipients (recovery + drill), have $n_recipients"

mkdir -p "$BACKUP_STAGING"
chmod 700 "$BACKUP_STAGING"
stamp=$(date -u +%Y-%m-%d-%H%M%S)
name="hippo-${stamp}.tar.gpg"
inner="/data/.backup-${stamp}.db"       # inside the container; /data is its only writable path
work=$(mktemp -d "${BACKUP_STAGING}/.work.XXXXXX")

cleanup() {
  rm -rf "$work" "${BACKUP_STAGING}/.${name}.partial"
  if [ "$SNAPSHOT_RUNNER" = docker ]; then
    docker exec "$CONTAINER" rm -f "$inner" >/dev/null 2>&1 || true
  else
    rm -f "${HOST_SNAPSHOT_DIR:-/nonexistent}/.backup-${stamp}.db"
  fi
}
trap cleanup EXIT

log "snapshot → ${name}"
if [ "$SNAPSHOT_RUNNER" = docker ]; then
  docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true \
    || fail "container ${CONTAINER} is not running"
  # Fed over stdin so the tool needs nothing inside the image; cwd is the image's /app,
  # where the driver resolves. HIPPO_PASSPHRASE is already in the container's env.
  docker exec -i "$CONTAINER" node --input-type=module - snapshot "$inner" \
    < "${SCRIPT_DIR}/hippo-dbtool.mjs" > "${work}/manifest.json" \
    || fail "snapshot failed: $(tail -c 300 "${work}/manifest.json")"
  docker cp "${CONTAINER}:${inner}" "${work}/hippocampus.db" || fail "docker cp of the snapshot failed"
else
  inner="${HOST_SNAPSHOT_DIR:?}/.backup-${stamp}.db"
  (cd "${HOST_NODE_CWD:?}" && node --input-type=module - snapshot "$inner") \
    < "${SCRIPT_DIR}/hippo-dbtool.mjs" > "${work}/manifest.json" \
    || fail "snapshot failed: $(tail -c 300 "${work}/manifest.json")"
  cp "$inner" "${work}/hippocampus.db"
fi

grep -q '"ok":true' "${work}/manifest.json" || fail "snapshot manifest not ok: $(head -c 300 "${work}/manifest.json")"
want_bytes=$(sed -n 's/.*"bytes":\([0-9][0-9]*\).*/\1/p' "${work}/manifest.json")
got_bytes=$(wc -c < "${work}/hippocampus.db" | tr -d ' ')
[ -n "$want_bytes" ] && [ "$want_bytes" = "$got_bytes" ] \
  || fail "copied snapshot is ${got_bytes} bytes, manifest says ${want_bytes:-nothing}"
log "snapshot ok: ${got_bytes} bytes; $(sed -n 's/.*"counts":\({[^}]*}\).*/\1/p' "${work}/manifest.json")"

(cd "$work" && sha256sum hippocampus.db manifest.json > SHA256SUMS)

recipient_args=()
for r in $GPG_RECIPIENTS; do recipient_args+=(-r "$r"); done
partial="${BACKUP_STAGING}/.${name}.partial"
tar -C "$work" -cf - hippocampus.db manifest.json SHA256SUMS \
  | gpg --batch --yes --quiet --trust-model always "${recipient_args[@]}" --encrypt --output "$partial" \
  || fail "tar | gpg failed"
[ -s "$partial" ] || fail "encrypted bundle is empty"
# The bundle must name every recipient. Counted from the packets, not trusted from argv.
enc_to=$(gpg --batch --list-packets "$partial" 2>/dev/null | grep -c '^:pubkey enc packet' || true)
[ "$enc_to" = "$n_recipients" ] || fail "bundle is encrypted to ${enc_to} keys, expected ${n_recipients}"
mv "$partial" "${BACKUP_STAGING}/${name}"
enc_bytes=$(wc -c < "${BACKUP_STAGING}/${name}" | tr -d ' ')
log "bundle ok: ${name} (${enc_bytes} bytes, ${enc_to} recipients)"

# --- prune SELECTION: keep a bundle if it is among the newest RETENTION OR younger than
# RETENTION_DAYS (union, as AppKeep: the count alone silently changes meaning when the
# timer cadence changes). Names sort chronologically. A name that does not parse is kept.
# Nothing is deleted here; deletion happens after the mirror, offsite FIRST.
cutoff=$(date -u -d "-${RETENTION_DAYS} days" +%Y%m%d%H%M%S 2>/dev/null \
  || date -u -v "-${RETENTION_DAYS}d" +%Y%m%d%H%M%S 2>/dev/null || true)
expired=()
bundles=()
for f in "${BACKUP_STAGING}"/hippo-*.tar.gpg; do [ -f "$f" ] && bundles+=("$f"); done
count=${#bundles[@]}
if [ -z "$cutoff" ]; then
  log "PRUNE SKIPPED: could not compute the ${RETENTION_DAYS}-day cutoff; ${count} bundles kept"
elif [ "$count" -gt "$RETENTION" ]; then
  drop=$((count - RETENTION))
  for f in "${bundles[@]:0:$drop}"; do
    s=${f##*/hippo-}; s=${s%.tar.gpg}; s=$(printf '%s' "$s" | tr -d '-')
    case "$s" in ''|*[!0-9]*) log "keep  ${f##*/} (unparseable stamp)"; continue ;; esac
    [ "${#s}" -eq 14 ] || { log "keep  ${f##*/} (stamp not 14 digits)"; continue; }
    # Never the bundle this run just made, whatever the clock or a stray name says.
    [ "${f##*/}" = "$name" ] && continue
    if [ "$s" -lt "$cutoff" ]; then expired+=("${f##*/}"); fi
  done
fi

# --- mirror. Push WITHOUT --delete. A blanket --delete would make the offsite set equal
# the local one, and the local set is EMPTY on a rebuilt box: the first nightly there
# would delete every older recovery point offsite, on the day they matter most (review
# finding, 2026-10-22). Offsite deletion is instead limited to the expired names above.
# Cost: bundles that never pass through this box's prune (e.g. from before a rebuild) stay
# offsite until removed by hand. That is the safe direction.
rsync_ssh=()
case "$BACKUP_REMOTE" in
  *:*)
    : "${BACKUP_SSH_KEY:?set BACKUP_SSH_KEY}"
    rsync_ssh=(--timeout=300 -e "ssh -p ${BACKUP_SSH_PORT} -i ${BACKUP_SSH_KEY} -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${BACKUP_KNOWN_HOSTS:-/etc/hippocampus/storagebox_known_hosts}")
    ;;
  *) mkdir -p "$BACKUP_REMOTE" ;;
esac
log "mirror → offsite"
rsync -a "${rsync_ssh[@]}" --include='hippo-*.tar.gpg' --exclude='*' \
  "${BACKUP_STAGING}/" "${BACKUP_REMOTE%/}/" \
  || fail "offsite mirror failed; ${name} is safe locally and ships on the next run"

# --- prune: offsite FIRST, local only once offsite succeeded. The local copy is what puts
# a name on the expired list, so keeping it after a failed offsite delete means the next
# run selects the same name and retries. Deleting locally first lost that retry for good:
# a bundle expired on a night the offsite step failed stayed offsite forever (round-2
# review, 2026-10-22).
if [ "${#expired[@]}" -gt 0 ]; then
  # Exactly the expired names: an empty source dir, --delete, and an include list of
  # those names only, so nothing else offsite is eligible. Names are digits and dashes
  # (checked above), so no rsync wildcard can get in.
  empty="${work}/empty"; mkdir -p "$empty"
  incl=(); for n in "${expired[@]}"; do incl+=(--include="$n"); done
  if rsync -r --delete "${rsync_ssh[@]}" "${incl[@]}" --exclude='*' "${empty}/" "${BACKUP_REMOTE%/}/"; then
    for n in "${expired[@]}"; do
      log "prune ${n}"
      rm -f "${BACKUP_STAGING}/${n}" || log "WARN: could not remove ${n} locally"
    done
  else
    log "WARN: offsite prune failed; ${#expired[@]} expired bundles kept on both sides, retried next run"
  fi
fi
log "DONE ${name} offsite (${enc_bytes} bytes)"
