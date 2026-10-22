#!/usr/bin/env bash
# Hippocampus restore drill + backup freshness check (D27). Runs on the DRILL HOST,
# never on the hippo box: the disaster is losing that box, so recoverability is proven
# with keys that are not on it.
#
#   hippo-restore-drill.sh drill [bundle.tar.gpg]   monthly: fetch the newest offsite
#       bundle (or use the one given) → gpg decrypt (drill key) → untar → sha256sum -c →
#       open it in a SCRATCH container (no network, read-only, all caps dropped) with
#       the passphrase → PRAGMA integrity_check, schema version, and entity /
#       observation / relationship / embedding counts must EQUAL the manifest written
#       at snapshot time → PASS / FAIL.
#   hippo-restore-drill.sh freshness                daily: the newest offsite bundle
#       must be younger than FRESH_MAX_HOURS. This is how a failed nightly backup on
#       the hippo box gets noticed, since that box cannot reach the alert sink.
#
# "Against live": the manifest IS live at snapshot time (counted from the snapshot the
# moment it was taken, inside the running container). Comparing against the live db
# at drill time would need a tolerance, and a tolerance is where a false PASS lives.
#
# Every result is one line appended to DRILL_LOG (the dated record prod-check BKP-03
# asks for) and one alert through ops-kit's notify.sh (ALERT_* env; error on FAIL,
# resolved on the first PASS after a FAIL, info on a routine PASS). Exit 0 = PASS.
#
# Config: /etc/hippocampus-drill/drill.env (see drill.env.example).
# Tests: DRILL_RUNNER=host runs the verify step with host node instead of docker.
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG=${DRILL_CONFIG:-/etc/hippocampus-drill/drill.env}
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"

mode=${1:-drill}
bundle_arg=${2:-}
: "${DRILL_STATE:?set DRILL_STATE (writable dir: log, last result)}"
DRILL_LOG=${DRILL_LOG:-${DRILL_STATE}/drill.log}
DRILL_RUNNER=${DRILL_RUNNER:-docker}
DRILL_IMAGE=${DRILL_IMAGE:-hippo-drill:latest}
FRESH_MAX_HOURS=${FRESH_MAX_HOURS:-28}
BACKUP_SSH_PORT=${BACKUP_SSH_PORT:-23}
NOTIFY=${NOTIFY:-}
mkdir -p "$DRILL_STATE"

log() { printf '%s  %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# notify <severity> <title> <body>: ops-kit's notify.sh when configured, stdout always.
# A failed delivery is logged but never turns a PASS into a FAIL or hides a FAIL.
notify() {
  if [ -n "$NOTIFY" ] && [ -x "$NOTIFY" ]; then
    NOTIFY_SOURCE="hippo-restore-drill" NOTIFY_FINGERPRINT="hippo-restore-drill:${mode}" \
      "$NOTIFY" "$1" "$2" "$3" || log "WARN: alert delivery failed (see above)"
  else
    log "[alert ${1}] ${2}: ${3}"
  fi
}

# finish <PASS|FAIL> <stage> <detail>: the single exit. Records, alerts, exits.
finish() {
  local result=$1 stage=$2 detail=$3 prev="" sev
  [ -f "${DRILL_STATE}/last-${mode}" ] && prev=$(cat "${DRILL_STATE}/last-${mode}")
  printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$mode" "$result" "$stage" "$detail" >> "$DRILL_LOG"
  printf '%s\n' "$result" > "${DRILL_STATE}/last-${mode}"
  if [ "$result" = PASS ]; then
    if [ "$prev" = FAIL ]; then sev=resolved; else sev=info; fi
    # A daily freshness PASS is noise; only its recovery is worth a push.
    if [ "$mode" = drill ] || [ "$sev" = resolved ]; then
      notify "$sev" "hippo ${mode} PASS" "$detail"
    fi
    log "PASS ${mode}: ${detail}"
    exit 0
  fi
  notify error "hippo ${mode} FAIL: ${stage}" "$detail"
  log "FAIL ${mode} at ${stage}: ${detail}"
  exit 1
}

# Called for an unexpected error under set -e, so a crash is still a recorded FAIL.
trap 'rc=$?; [ $rc -ne 0 ] && [ -z "${FINISHED:-}" ] && { FINISHED=1; finish FAIL crash "line ${LINENO}, exit ${rc}"; }' EXIT
finish_() { FINISHED=1; finish "$@"; }

ssh_cmd() { printf 'ssh -p %s -i %s -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=%s' \
  "$BACKUP_SSH_PORT" "${BACKUP_SSH_KEY:?}" "${BACKUP_KNOWN_HOSTS:-/etc/hippocampus-drill/storagebox_known_hosts}"; }

# newest_remote: sets NEWEST to the newest bundle name on the offsite target ("" if none).
# Sets a global rather than printing: called inside $(…), a finish_ would only exit the
# subshell, and the caller would carry on to a second, misleading FAIL.
newest_remote() {
  local listing
  case "${BACKUP_REMOTE:?set BACKUP_REMOTE}" in
    *:*) listing=$(rsync --list-only --timeout=120 -e "$(ssh_cmd)" "${BACKUP_REMOTE%/}/" 2>&1) \
           || finish_ FAIL list "cannot list the offsite target: ${listing:0:200}" ;;
    *)   listing=$(ls -1a "$BACKUP_REMOTE" 2>&1) || finish_ FAIL list "cannot list ${BACKUP_REMOTE}" ;;
  esac
  # Anchored to the WHOLE name (last field of an `rsync --list-only` line, or an `ls` line):
  # an unanchored match also finds `hippo-<stamp>.tar.gpg` inside rsync's receiver temp
  # file `.hippo-<stamp>.tar.gpg.XXXXXX`, a bundle that never landed.
  NEWEST=$(printf '%s\n' "$listing" | awk '{print $NF}' \
    | grep -E '^hippo-[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.tar\.gpg$' | sort | tail -1 || true)
}

# age_seconds <bundle name>: seconds since the stamp in the name (UTC).
age_seconds() {
  local s=${1#hippo-}; s=${s%.tar.gpg}
  local iso="${s:0:10} ${s:11:2}:${s:13:2}:${s:15:2}" then
  then=$(date -u -d "$iso" +%s 2>/dev/null || date -u -j -f '%Y-%m-%d %H:%M:%S' "$iso" +%s 2>/dev/null) || return 1
  echo $(( $(date -u +%s) - then ))
}

if [ "$mode" = freshness ]; then
  newest_remote; newest=$NEWEST
  [ -n "$newest" ] || finish_ FAIL freshness "no hippo bundle on the offsite target"
  secs=$(age_seconds "$newest") || finish_ FAIL freshness "cannot date ${newest}"
  # Compared in SECONDS: flooring to whole hours turned 30h30m into "30h" and passed a
  # missed night at a 30h limit (review finding, 2026-10-22).
  [ "$secs" -le $(( FRESH_MAX_HOURS * 3600 )) ] \
    || finish_ FAIL freshness "newest bundle ${newest} is $((secs / 3600))h$(( secs % 3600 / 60 ))m old (max ${FRESH_MAX_HOURS}h): the nightly backup on hippo is not landing"
  finish_ PASS freshness "newest ${newest}, $((secs / 3600))h$(( secs % 3600 / 60 ))m old"
fi

[ "$mode" = drill ] || { echo "usage: $0 drill [bundle] | freshness" >&2; FINISHED=1; exit 2; }

: "${GNUPGHOME:?set GNUPGHOME (holds the DRILL private key)}"
: "${HIPPO_PASSPHRASE_FILE:?set HIPPO_PASSPHRASE_FILE}"
export GNUPGHOME
[ -r "$HIPPO_PASSPHRASE_FILE" ] || finish_ FAIL config "passphrase file not readable"

work=$(mktemp -d "${DRILL_STATE}/.work.XXXXXX")
trap 'rc=$?; rm -rf "$work"; [ $rc -ne 0 ] && [ -z "${FINISHED:-}" ] && { FINISHED=1; finish FAIL crash "line ${LINENO}, exit ${rc}"; }' EXIT

if [ -n "$bundle_arg" ]; then
  bundle=$bundle_arg
  name=${bundle##*/}
else
  newest_remote; name=$NEWEST
  [ -n "$name" ] || finish_ FAIL fetch "no hippo bundle on the offsite target"
  bundle="${work}/${name}"
  case "$BACKUP_REMOTE" in
    *:*) rsync -a --timeout=300 -e "$(ssh_cmd)" "${BACKUP_REMOTE%/}/${name}" "$bundle" \
           || finish_ FAIL fetch "rsync of ${name} failed" ;;
    *)   cp "${BACKUP_REMOTE%/}/${name}" "$bundle" || finish_ FAIL fetch "copy of ${name} failed" ;;
  esac
fi
[ -s "$bundle" ] || finish_ FAIL fetch "${name} is missing or empty"
log "drill on ${name} ($(wc -c < "$bundle" | tr -d ' ') bytes)"

mkdir -p "${work}/restore"
gpg --batch --quiet --decrypt --output "${work}/bundle.tar" "$bundle" 2>"${work}/gpg.err" \
  || finish_ FAIL decrypt "${name}: $(tr '\n' ' ' < "${work}/gpg.err" | cut -c1-200)"
tar -C "${work}/restore" -xf "${work}/bundle.tar" hippocampus.db manifest.json SHA256SUMS 2>"${work}/tar.err" \
  || finish_ FAIL untar "${name}: $(tr '\n' ' ' < "${work}/tar.err" | cut -c1-200)"
(cd "${work}/restore" && sha256sum -c --quiet SHA256SUMS >/dev/null 2>&1) \
  || finish_ FAIL checksum "${name}: SHA256SUMS does not match the restored files"

HIPPO_PASSPHRASE=$(cat "$HIPPO_PASSPHRASE_FILE")
export HIPPO_PASSPHRASE
if [ "$DRILL_RUNNER" = docker ]; then
  # Passphrase by NAME (-e VAR), so its value is never on a command line.
  out=$(docker run --rm --network none --read-only --cap-drop ALL \
          --security-opt no-new-privileges --tmpfs /tmp:size=16m \
          -e HIPPO_PASSPHRASE -v "${work}/restore:/restore" -i \
          "$DRILL_IMAGE" node --input-type=module - verify /restore/hippocampus.db /restore/manifest.json \
          < "${SCRIPT_DIR}/hippo-dbtool.mjs" 2>&1) || true
else
  out=$(cd "${HOST_NODE_CWD:?}" && node --input-type=module - verify \
          "${work}/restore/hippocampus.db" "${work}/restore/manifest.json" \
          < "${SCRIPT_DIR}/hippo-dbtool.mjs" 2>&1) || true
fi
unset HIPPO_PASSPHRASE
# `|| true`: with no JSON line, grep exits 1 and set -e would end the run in the EXIT trap
# as a bare "crash", hiding the verifier's own error from the alert. Nothing reads
# PIPESTATUS here.
result=$(printf '%s\n' "$out" | grep '^{' | tail -1 || true)
case "$result" in
  *'"ok":true'*) ;;
  *'"ok":false'*)
    stage=$(printf '%s' "$result" | sed -n 's/.*"stage":"\([a-z]*\)".*/\1/p')
    reason=$(printf '%s' "$result" | sed -n 's/.*"reason":"\(.*\)"}.*/\1/p')
    finish_ FAIL "verify-${stage:-unknown}" "${name}: ${reason:0:240}" ;;
  *) finish_ FAIL verify "${name}: verifier produced no result: $(printf '%s' "$out" | tail -c 200 | tr '\n' ' ')" ;;
esac
counts=$(printf '%s' "$result" | sed -n 's/.*"counts":{\([^}]*\)}.*/\1/p' | tr -d '"')
age=$(( $(age_seconds "$name" || echo 0) / 3600 ))
finish_ PASS restore "${name} (${age}h old): integrity ok, counts equal manifest: ${counts}"
