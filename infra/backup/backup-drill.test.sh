#!/usr/bin/env bash
# End-to-end test of the backup → offsite → drill chain, on a laptop or CI, with no
# docker, no network and no real keys (D27). Run from the repo root after `npm ci`:
#
#   bash infra/backup/backup-drill.test.sh
#
# The drill is only proven if a bad bundle FAILS it, so every FAIL case below is built
# from the same good bundle that PASSES, changing one thing:
#   good bundle                                  → PASS
#   truncated .gpg file                          → FAIL at decrypt
#   GPG-valid bundle, truncated db, old SHA256   → FAIL at checksum
#   GPG-valid bundle, truncated db, SHA256 redone → FAIL at verify (integrity/open)
#   GPG-valid bundle, manifest counts +1         → FAIL at verify-counts
# plus: the recovery key alone decrypts (two recipients, really), freshness PASS/FAIL,
# and the prune keeps the newest RETENTION bundles and drops only old ones.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
B="$REPO/infra/backup"
# Short root on purpose: gpg-agent sockets live in GNUPGHOME and a socket path over ~100
# chars (the macOS TMPDIR is one) stops the agent, and with it key generation.
T=$(mktemp -d /tmp/hbt.XXXXXX)
trap 'gpgconf --homedir "$T/gpg-recovery" --kill gpg-agent 2>/dev/null; gpgconf --homedir "$T/gpg-drill" --kill gpg-agent 2>/dev/null; rm -rf "$T"' EXIT
pass=0; failn=0
ok()   { pass=$((pass + 1)); printf 'ok   %s\n' "$*"; }
bad()  { failn=$((failn + 1)); printf 'FAIL %s\n' "$*"; }
expect() { # expect <PASS|FAIL> <stage-glob> <label> -- cmd…
  local want=$1 stage=$2 label=$3; shift 4
  if "$@" > "$T/out" 2>&1; then got=PASS; else got=FAIL; fi
  local line; line=$(tail -1 "$DRILL_STATE/drill.log" 2>/dev/null || true)
  local pat="$want:* $want $stage *"   # unquoted below on purpose: $stage may be a glob
  # shellcheck disable=SC2254
  case "$got:$line" in
    $pat) ok "$label ($got at $(echo "$line" | awk '{print $4}'))" ;;
    *) bad "$label: wanted $want/$stage, got $got; log: $line"; sed 's/^/     /' "$T/out" | tail -8 ;;
  esac
}

# --- keys: recovery + drill, each in its own home; the backup home has PUBLIC keys only.
mk_key() { # mk_key <home> <uid>
  mkdir -p "$1"; chmod 700 "$1"
  GNUPGHOME="$1" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-gen-key "$2" ed25519 cert never
  local fpr; fpr=$(GNUPGHOME="$1" gpg --batch --with-colons --list-keys "$2" | awk -F: '/^fpr/{print $10; exit}')
  GNUPGHOME="$1" gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-add-key "$fpr" cv25519 encr never
  echo "$fpr"
}
REC=$(mk_key "$T/gpg-recovery" "recovery@test.invalid")
DRL=$(mk_key "$T/gpg-drill" "drill@test.invalid")
mkdir -p "$T/gpg-pub"; chmod 700 "$T/gpg-pub"
GNUPGHOME="$T/gpg-recovery" gpg --batch --export "$REC" | GNUPGHOME="$T/gpg-pub" gpg --batch --quiet --import
GNUPGHOME="$T/gpg-drill"    gpg --batch --export "$DRL" | GNUPGHOME="$T/gpg-pub" gpg --batch --quiet --import

# --- a live database created by the app itself, with rows in every counted table but one.
mkdir -p "$T/data"
LIVE_PASSPHRASE="test-passphrase-backup-e2e"
export HIPPO_PASSPHRASE="$LIVE_PASSPHRASE"
export HIPPO_DB_PATH="$T/data/hippocampus.db"
(cd "$REPO" && npx tsx -e "(async () => {
const { initDatabase, closeDatabase } = await import('./src/db/index.ts');
const { findOrCreateEntity } = await import('./src/db/entities.ts');
const { createObservation } = await import('./src/db/observations.ts');
const { createRelationship } = await import('./src/db/relationships.ts');
initDatabase();
const a = findOrCreateEntity('e2e-a', 'project'), b = findOrCreateEntity('e2e-b', 'person');
for (let i = 0; i < 25; i++) createObservation(a.id, 'observation number ' + i, undefined, 1.0, 'fact');
createRelationship(a.id, b.id, 'works_with');
closeDatabase();
})()")

# --- backup
export BACKUP_CONFIG=/nonexistent DRILL_CONFIG=/nonexistent
run_backup() {
  GPG_RECIPIENTS="$REC $DRL" GNUPGHOME="$T/gpg-pub" BACKUP_STAGING="$T/staging" \
  BACKUP_REMOTE="$T/offsite" SNAPSHOT_RUNNER=host HOST_SNAPSHOT_DIR="$T/data" HOST_NODE_CWD="$REPO" \
  RETENTION="${1:-14}" RETENTION_DAYS="${2:-14}" HIPPO_PASSPHRASE="$LIVE_PASSPHRASE" bash "$B/hippo-backup.sh"
}
if run_backup > "$T/backup.out" 2>&1; then ok "backup run exits 0"; else bad "backup run"; cat "$T/backup.out"; fi
GOOD=$(ls "$T/offsite"/hippo-*.tar.gpg 2>/dev/null | tail -1)
[ -n "$GOOD" ] && ok "bundle mirrored offsite: ${GOOD##*/}" || bad "no bundle offsite"
ls "$T/data" | grep -q '^\.backup-' && bad "snapshot temp file left behind" || ok "snapshot temp file cleaned up"
GNUPGHOME="$T/gpg-recovery" gpg --batch --quiet --decrypt "$GOOD" 2>/dev/null | tar -tf - | sort | tr '\n' ' ' > "$T/members"
[ "$(cat "$T/members")" = "SHA256SUMS hippocampus.db manifest.json " ] \
  && ok "recovery key alone decrypts: $(cat "$T/members")" || bad "recovery key decrypt: $(cat "$T/members")"
# list-packets exits non-zero without a secret key, so count first and test the number.
n_enc=$(GNUPGHOME="$T/gpg-pub" gpg --batch --list-packets "$GOOD" 2>/dev/null | grep -c '^:pubkey enc packet' || true)
[ "$n_enc" = 2 ] && ok "bundle names two recipients" || bad "recipient count: $n_enc"

# --- drill
export DRILL_STATE="$T/drill-state" DRILL_RUNNER=host HOST_NODE_CWD="$REPO"
export GNUPGHOME="$T/gpg-drill" BACKUP_REMOTE="$T/offsite"
printf '%s' "$HIPPO_PASSPHRASE" > "$T/passphrase"; export HIPPO_PASSPHRASE_FILE="$T/passphrase"
unset HIPPO_PASSPHRASE

expect PASS restore "good bundle, fetched as newest offsite" -- bash "$B/hippo-restore-drill.sh" drill
grep -q 'observations:25' "$DRILL_STATE/drill.log" && ok "PASS line carries the counts" || bad "counts missing from log"

# truncated .gpg
cp "$GOOD" "$T/trunc.tar.gpg"; truncate -s $(( $(wc -c < "$GOOD") / 2 )) "$T/trunc.tar.gpg" 2>/dev/null \
  || python3 -c "import sys;f=open(sys.argv[1],'r+b');import os;f.truncate(os.path.getsize(sys.argv[1])//2)" "$T/trunc.tar.gpg"
expect FAIL decrypt "truncated .gpg" -- bash "$B/hippo-restore-drill.sh" drill "$T/trunc.tar.gpg"

# re-wrap helpers: decrypt the good bundle, tamper, re-encrypt to the drill key
unwrap() { rm -rf "$T/x"; mkdir -p "$T/x"; GNUPGHOME="$T/gpg-drill" gpg --batch --quiet --decrypt "$GOOD" | tar -C "$T/x" -xf -; }
rewrap() { tar -C "$T/x" -cf - hippocampus.db manifest.json SHA256SUMS \
  | GNUPGHOME="$T/gpg-pub" gpg --batch --yes --quiet --trust-model always -r "$DRL" --encrypt --output "$1"; }
halve()  { python3 -c "import sys,os;f=open(sys.argv[1],'r+b');f.truncate(os.path.getsize(sys.argv[1])//2)" "$1"; }

unwrap; halve "$T/x/hippocampus.db"; rewrap "$T/bad-sum.tar.gpg"
expect FAIL checksum "GPG-valid, truncated db, original SHA256SUMS" -- bash "$B/hippo-restore-drill.sh" drill "$T/bad-sum.tar.gpg"

unwrap; halve "$T/x/hippocampus.db"; (cd "$T/x" && sha256sum hippocampus.db manifest.json > SHA256SUMS); rewrap "$T/bad-db.tar.gpg"
expect FAIL 'verify-*' "GPG-valid, truncated db, SHA256SUMS recomputed" -- bash "$B/hippo-restore-drill.sh" drill "$T/bad-db.tar.gpg"

unwrap; sed -i.bak 's/"observations":25/"observations":26/' "$T/x/manifest.json"; rm -f "$T/x/manifest.json.bak"
(cd "$T/x" && sha256sum hippocampus.db manifest.json > SHA256SUMS); rewrap "$T/bad-count.tar.gpg"
expect FAIL verify-counts "GPG-valid, manifest counts off by one" -- bash "$B/hippo-restore-drill.sh" drill "$T/bad-count.tar.gpg"

expect PASS restore "good bundle again after FAILs" -- bash "$B/hippo-restore-drill.sh" drill "$GOOD"

# wrong passphrase on the drill host
printf 'not-the-passphrase' > "$T/wrongpass"
expect FAIL verify-open "wrong passphrase" -- env HIPPO_PASSPHRASE_FILE="$T/wrongpass" bash "$B/hippo-restore-drill.sh" drill "$GOOD"

# --- freshness
expect PASS freshness "freshness, bundle minutes old" -- bash "$B/hippo-restore-drill.sh" freshness
mkdir -p "$T/stale"; cp "$GOOD" "$T/stale/hippo-2020-01-01-020000.tar.gpg"
expect FAIL freshness "freshness, newest bundle years old" -- env BACKUP_REMOTE="$T/stale" bash "$B/hippo-restore-drill.sh" freshness
mkdir -p "$T/empty"
expect FAIL freshness "freshness, no bundle at all" -- env BACKUP_REMOTE="$T/empty" bash "$B/hippo-restore-drill.sh" freshness

# --- review findings 2026-10-22, one case each.
stamp_ago() { date -u -v "-${1}H" +%Y-%m-%d-%H%M%S 2>/dev/null || date -u -d "-${1} hours" +%Y-%m-%d-%H%M%S; }
# A missed night: the newest bundle is ~30.5h old at the 09:00 check. Hours were floored
# before, so 30h30m read as "30h" and passed a 30h limit.
# 28h30m, not 29h: floored to whole hours it reads 28 and passes, so only a seconds
# comparison fails it. That is what makes this case guard the fix.
missed=$(date -u -v-28H -v-30M +%Y-%m-%d-%H%M%S 2>/dev/null || date -u -d "-28 hours -30 minutes" +%Y-%m-%d-%H%M%S)
mkdir -p "$T/missed"; cp "$GOOD" "$T/missed/hippo-${missed}.tar.gpg"
expect FAIL freshness "freshness, newest bundle 28h30m old (limit 28h)" -- env BACKUP_REMOTE="$T/missed" bash "$B/hippo-restore-drill.sh" freshness
mkdir -p "$T/late"; cp "$GOOD" "$T/late/hippo-$(stamp_ago 27).tar.gpg"
expect PASS freshness "freshness, newest bundle 27h old (limit 28h)" -- env BACKUP_REMOTE="$T/late" bash "$B/hippo-restore-drill.sh" freshness
# rsync's receiver temp file for a bundle that never landed must not count as fresh.
mkdir -p "$T/temp"; cp "$GOOD" "$T/temp/hippo-2020-01-01-020000.tar.gpg"
cp "$GOOD" "$T/temp/.hippo-$(stamp_ago 1).tar.gpg.Ab12Cd"
expect FAIL freshness "freshness ignores an rsync temp file" -- env BACKUP_REMOTE="$T/temp" bash "$B/hippo-restore-drill.sh" freshness
# A verifier that cannot run must FAIL at verify with its own error, not as a bare crash.
expect FAIL verify "verifier cannot load the driver" -- env HOST_NODE_CWD=/ bash "$B/hippo-restore-drill.sh" drill "$GOOD"
grep -q 'verifier produced no result' "$DRILL_STATE/drill.log" && ok "the verify FAIL carries the verifier's output" || bad "verify FAIL lacks diagnostic"

# A rebuilt hippo box starts with an EMPTY staging dir. Its first nightly must add to the
# offsite history, not replace it (a blanket rsync --delete did).
mkdir -p "$T/rebuilt-off"
for st in 2026-01-01-020000 "$(stamp_ago 48)" "$(stamp_ago 24)"; do cp "$GOOD" "$T/rebuilt-off/hippo-$st.tar.gpg"; done
GPG_RECIPIENTS="$REC $DRL" GNUPGHOME="$T/gpg-pub" BACKUP_STAGING="$T/rebuilt-staging" \
  BACKUP_REMOTE="$T/rebuilt-off" SNAPSHOT_RUNNER=host HOST_SNAPSHOT_DIR="$T/data" HOST_NODE_CWD="$REPO" \
  RETENTION=14 RETENTION_DAYS=14 HIPPO_PASSPHRASE="$LIVE_PASSPHRASE" bash "$B/hippo-backup.sh" > "$T/rebuilt.out" 2>&1 \
  || { bad "rebuilt-box backup run"; cat "$T/rebuilt.out"; }
n_rebuilt=$(ls "$T/rebuilt-off"/hippo-*.tar.gpg | wc -l | tr -d ' ')
[ "$n_rebuilt" = 4 ] && ok "rebuilt box: offsite history kept (3 old + 1 new)" || bad "rebuilt box: offsite has $n_rebuilt bundles: $(ls "$T/rebuilt-off" | tr '\n' ' ')"

# Expiry must survive a failing offsite step: the local copy is what selects a bundle, so
# it may only go after the offsite delete succeeded. Failures are injected with an rsync
# shim on PATH, so they hit the rsync calls themselves (a real ssh remote takes the same
# path). Night 1: the mirror push fails. Night 2: the push works, the offsite delete fails.
# Night 3: everything works and the expired bundle goes on both sides.
mkdir -p "$T/n-staging" "$T/n-off" "$T/shim"; cp "$GOOD" "$T/n-staging/hippo-2020-01-01-020000.tar.gpg"
cp "$GOOD" "$T/n-off/hippo-2020-01-01-020000.tar.gpg"
REAL_RSYNC=$(command -v rsync)
cat > "$T/shim/rsync" <<SHIM
#!/usr/bin/env bash
case "\$SHIM_FAIL:\$*" in
  push:*--delete*) ;;
  push:*) exit 23 ;;
  delete:*--delete*) exit 23 ;;
esac
exec "$REAL_RSYNC" "\$@"
SHIM
chmod +x "$T/shim/rsync"
night() { PATH="$T/shim:$PATH" GPG_RECIPIENTS="$REC $DRL" GNUPGHOME="$T/gpg-pub" BACKUP_STAGING="$T/n-staging" \
  BACKUP_REMOTE="$T/n-off" SNAPSHOT_RUNNER=host HOST_SNAPSHOT_DIR="$T/data" HOST_NODE_CWD="$REPO" \
  RETENTION=1 RETENTION_DAYS=14 HIPPO_PASSPHRASE="$LIVE_PASSPHRASE" bash "$B/hippo-backup.sh"; }
OLD=hippo-2020-01-01-020000.tar.gpg
both() { [ -f "$T/n-staging/$OLD" ] && [ -f "$T/n-off/$OLD" ]; }
SHIM_FAIL=push night > "$T/n1.out" 2>&1 && bad "night 1 should fail" || true
grep -q 'FAIL: offsite mirror failed' "$T/n1.out" && both \
  && ok "night 1: push fails, expired bundle kept on both sides" || { bad "night 1"; tail -3 "$T/n1.out"; }
sleep 1
SHIM_FAIL=delete night > "$T/n2.out" 2>&1 || { bad "night 2 run"; tail -3 "$T/n2.out"; }
grep -q 'WARN: offsite prune failed' "$T/n2.out" && both \
  && ok "night 2: offsite delete fails, kept on both sides for the retry" || { bad "night 2"; tail -3 "$T/n2.out"; }
sleep 1
SHIM_FAIL= night > "$T/n3.out" 2>&1 || { bad "night 3 run"; tail -3 "$T/n3.out"; }
[ ! -f "$T/n-off/$OLD" ] && [ ! -f "$T/n-staging/$OLD" ] \
  && ok "night 3: expired bundle removed offsite and locally" || bad "night 3: $(ls "$T/n-off" "$T/n-staging" | tr '\n' ' ')"

# Paging: the backup pages once on FAIL and never on success; the drill loads ops-kit's
# config file and pages with its sink settings in the notifier's environment.
cat > "$T/shim/notify" <<'NTF'
#!/usr/bin/env bash
printf '%s|%s|%s|%s\n' "$NOTIFY_SOURCE" "$1" "$2" "${ALERT_WEBHOOK_URL:-unset}" >> "$PAGES"
NTF
chmod +x "$T/shim/notify"; export PAGES="$T/pages"; : > "$PAGES"
printf 'ALERT_WEBHOOK_URL=https://sink.test.invalid/topic\nNOTIFY_FORMAT=ntfy\n' > "$T/ops-kit.env"
NOTIFY="$T/shim/notify" OPSKIT_ENV="$T/ops-kit.env" SHIM_FAIL=push night > /dev/null 2>&1 || true
NOTIFY="$T/shim/notify" OPSKIT_ENV="$T/ops-kit.env" SHIM_FAIL= night > /dev/null 2>&1 || true
[ "$(cat "$PAGES")" = "hippo-backup|error|hippo backup FAIL|https://sink.test.invalid/topic" ] \
  && ok "backup pages once on FAIL, not on success, with ops-kit's sink" || bad "backup pages: $(cat "$PAGES" | tr '\n' ';')"
: > "$PAGES"
NOTIFY="$T/shim/notify" OPSKIT_ENV="$T/ops-kit.env" bash "$B/hippo-restore-drill.sh" drill "$T/trunc.tar.gpg" > /dev/null 2>&1 || true
grep -q '^hippo-restore-drill|error|hippo drill FAIL: decrypt|https://sink.test.invalid/topic$' "$PAGES" \
  && ok "drill pages FAIL with ops-kit's sink settings exported" || bad "drill pages: $(cat "$PAGES" | tr '\n' ';')"

# --- prune: two ancient bundles + the real one, RETENTION=1 / 14 days → ancient ones go,
# then a second run keeps both real bundles because they are inside the day window.
cp "$GOOD" "$T/staging/hippo-2020-01-01-020000.tar.gpg"; cp "$GOOD" "$T/staging/hippo-2020-01-02-020000.tar.gpg"
sleep 1
run_backup 1 14 > "$T/backup2.out" 2>&1 || { bad "second backup run"; cat "$T/backup2.out"; }
n_local=$(ls "$T/staging"/hippo-*.tar.gpg | wc -l | tr -d ' ')
n_off=$(ls "$T/offsite"/hippo-*.tar.gpg | wc -l | tr -d ' ')
[ "$n_local" = 2 ] && [ "$n_off" = 2 ] && ! ls "$T/offsite" | grep -q 2020 \
  && ok "prune: ancient bundles dropped locally and offsite, two recent kept" \
  || bad "prune: local=$n_local offsite=$n_off: $(ls "$T/offsite" | tr '\n' ' ')"

echo "---"; echo "$pass passed, $failn failed"
[ "$failn" -eq 0 ]
