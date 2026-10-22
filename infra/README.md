# infra/: backup and restore drill

Nightly encrypted backups of the Hippocampus database, mirrored offsite, and a monthly
drill that proves the newest one restores. Decision and reasoning: `DECISIONS.md` D27.

## What runs where

| Box | Path on the box | From this repo | What it does |
|---|---|---|---|
| hippo box | `/opt/hippocampus` (the deploy checkout) | whole repo | the app, plus the backup script below |
| hippo box | `/etc/systemd/system/hippo-backup.{service,timer}` | `infra/systemd/hippo-backup.*` | nightly 02:30 UTC: snapshot, encrypt, mirror offsite |
| hippo box | `/etc/hippocampus/backup.env` (600) | `infra/backup/backup.env.example` | recipients, offsite target, retention |
| hippo box | `/var/lib/hippocampus-backup/gnupg` | none | the two PUBLIC keys only |
| hippo box | `/var/backups/hippocampus` | none | local copies of the retained bundles |
| drill host | `/opt/hippocampus` (a read-only checkout) | whole repo | the drill script and the drill image |
| drill host | `/etc/systemd/system/hippo-restore-drill.{service,timer}` | `infra/systemd/hippo-restore-drill.*` | 1st of the month 06:00 UTC: restore the newest offsite bundle and verify it |
| drill host | `/etc/systemd/system/hippo-backup-freshness.{service,timer}` | `infra/systemd/hippo-backup-freshness.*` | daily 09:00 UTC: alert if the newest offsite bundle is older than 28h |
| drill host | `/etc/hippocampus-drill/drill.env` (600) | `infra/backup/drill.env.example` | offsite target, passphrase file, notifier |
| drill host | `/var/lib/hippocampus-drill/` | none | the DRILL private key (`gnupg/`), `drill.log`, last results |
| offsite | Storage Box sub-account, base dir `hippocampus` | none | `hippo-YYYY-MM-DD-HHMMSS.tar.gpg`. New bundles are pushed, and only bundles the hippo box itself prunes are deleted, so a rebuilt box with an empty staging dir cannot wipe the history |

The drill host is a separate machine on purpose. The disaster being insured against is
losing the hippo box, so recovery is proven with keys that are not on it.

## The bundle

`hippo-<UTC stamp>.tar.gpg` is a tar of three files, GPG-encrypted to two keys:

- `hippocampus.db`: a `VACUUM INTO` copy taken inside the running container. It is
  transactionally consistent, and it stays encrypted by the app's own cipher
  (SQLite3MultipleCiphers, ChaCha20, key = `HIPPO_PASSPHRASE`). A `cp` of the live file
  would not be consistent: recent pages sit in the `-wal` file.
- `manifest.json`: counts of entities, observations, relationships and embeddings,
  schema version, cipher and `integrity_check`, all measured on the snapshot when it was taken.
- `SHA256SUMS`: covers the two files above.

The two keys:

- **recovery**: private half only in the password manager. This key restores Hippo after
  a total loss.
- **drill**: private half only on the drill host. This key lets the monthly drill run
  unattended.

Either key decrypts. Neither private half is on the hippo box. Opening the database still
needs `HIPPO_PASSPHRASE`, which must also be kept in the password manager.

## The drill

The drill passes only if all of these hold:

1. GPG decrypts the bundle.
2. The tar is intact.
3. `SHA256SUMS` matches.
4. The database opens with the passphrase in a scratch container (`--network none`, read-only, all capabilities dropped).
5. `PRAGMA integrity_check` returns `ok`.
6. Schema version and all four counts **equal** the manifest.

There is no tolerance. The manifest is live at snapshot time, and a tolerance against a
moving live count is where a false PASS hides.

Every run appends one dated line to `drill.log`, which is the record of when a restore
was last proven. Every run also alerts through ops-kit's `notify.sh`:

| Result | Severity |
|---|---|
| FAIL | `error` |
| first PASS after a FAIL | `resolved` |
| routine monthly PASS | `info` |
| daily freshness PASS | silent |

`infra/backup/backup-drill.test.sh` proves the drill can fail. It builds a good bundle,
then breaks it in turn:

| Variant | Must fail at |
|---|---|
| truncated `.gpg` | decrypt |
| truncated database, original sums | checksum |
| truncated database, re-summed | open / integrity |
| manifest count off by one | counts |
| wrong passphrase | open |

Run it locally with `bash infra/backup/backup-drill.test.sh` (needs `npm ci` and gpg; no
docker or network). `tests/backup-dbtool.test.ts` runs in the suite. It opens a database
created by the app with the backup tool, so a change to how the app opens its database
breaks the suite before it breaks a restore.

## Restoring for real (total loss of the hippo box)

1. Fetch the newest bundle from the Storage Box with the laptop's own key.
2. `gpg --decrypt hippo-….tar.gpg | tar -xf -` with the recovery key imported, then
   `sha256sum -c SHA256SUMS`.
3. On a fresh box, deploy the repo (README "Deploy"), stop the container, copy
   `hippocampus.db` into the data volume as `/data/hippocampus.db` owned by uid 1001,
   and start the container with the same `HIPPO_PASSPHRASE`.
4. `curl https://<your domain>/health`, then `recall` something you know is there.

The file opens with this app's driver (`better-sqlite3-multiple-ciphers`), not with the
`sqlcipher` CLI: the cipher is the driver's default, ChaCha20, not SQLCipher's AES.

## Setup

These steps change two production boxes, so each is run by hand. Set up the hippo box
first: the drill needs a bundle to restore.

1. **Keys** (laptop). Generate the recovery and drill keypairs. Put the recovery private
   key and `HIPPO_PASSPHRASE` in the password manager. Copy the drill private key to the
   drill host. Copy both public keys to the hippo box.
2. **Offsite** (Hetzner console). Create a Storage Box sub-account with base dir
   `hippocampus`, SSH on, external reachability on, read-only off. Install three keys on
   it with `ssh-copy-id -s -p 23`: the hippo box, the drill host and the laptop. Pin the
   host key into each box's `storagebox_known_hosts`. Turn on Storage Box snapshots: the
   hippo box's key can delete (it removes the bundles it prunes), so a compromised hippo box
   could otherwise empty the offsite copy.
3. **hippo box.** Copy `backup.env.example` to `/etc/hippocampus/backup.env` and fill it
   in. Install the two units, run the service once by hand, then enable the timer.
4. **Drill host.**
   1. Check out the repo to `/opt/hippocampus`.
   2. Build the image: `docker build -f infra/backup/drill.Dockerfile -t hippo-drill:latest infra/backup`.
   3. Copy `drill.env.example` to `/etc/hippocampus-drill/drill.env` and fill it in.
   4. Import the drill private key into `/var/lib/hippocampus-drill/gnupg`.
   5. Write the passphrase file. The drill key must have no passphrase: the drill runs
      gpg unattended, and a passphrase fails every drill at decrypt.
   6. Install the four units, run the drill once by hand, then enable both timers.
