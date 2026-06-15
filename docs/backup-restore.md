# Backup & Restore — `skytwin-backup`

`skytwin-backup` is a command-line tool that exports a user's SkyTwin data to a
single **encrypted** file and restores it onto a fresh install. It is the
"take my data with me" half of SkyTwin's data-ownership story; the
**Delete my data** flow ([#376](https://github.com/jayzalowitz/skytwin/issues/376),
`userPurgeRepository`) is the other half.

> Issue: [#400 — P3.2 Backup / restore CLI](https://github.com/jayzalowitz/skytwin/issues/400)
> (parent epic [#357](https://github.com/jayzalowitz/skytwin/issues/357)).

## What the backup contains

The backup is scoped to the data that *is* your twin:

| Data | Source table(s) |
|------|-----------------|
| Account | `users` |
| Twin profile + its full version history | `twin_profiles`, `twin_profile_versions` |
| Learned preferences | `preferences` |
| Decisions (with candidate actions, outcomes, and explanations) | `decisions`, `candidate_actions`, `decision_outcomes`, `explanation_records` |

### What it deliberately does **not** contain

- **OAuth tokens / credential-vault secrets.** A backup is a portable file you
  may store anywhere. Exporting tokens encrypted under a vault key that lives in
  a *different* keystore would export ciphertext the restore target can't read,
  and exporting them in the clear would be a credential-leak hazard. Connectors
  (Gmail, Calendar, …) **re-authorize on the restored install** — the same one
  re-auth you do on any new device.
- **Sessions, recovery codes, device-pairing state.** These are machine-local,
  not "your data."

## Encryption

The archive is a self-describing binary blob: a fixed header followed by an
**AES-256-GCM** ciphertext whose plaintext is the UTF-8 JSON of the exported
data. The key is derived from your passphrase with **scrypt**
(`N=2^15, r=8, p=1`, 32-byte key) and a random per-archive salt — the same
memory-hard crypto choices that guard the credential vault
(see [`@skytwin/credential-vault`](../packages/credential-vault/) and
[`docs/safety-model.md`](safety-model.md)).

The header (magic + format version + salt + IV) is fed to the cipher as
**additional authenticated data (AAD)**, so an attacker can't downgrade the
format version or swap the salt without the GCM tag failing closed.

Implementation: [`packages/db/src/backup/archive.ts`](../packages/db/src/backup/archive.ts).

A wrong passphrase, a tampered byte, a truncated file, or a non-SkyTwin blob
all **fail closed** with a typed error — never a partial decrypt.

## The passphrase

The passphrase is read from the **`SKYTWIN_BACKUP_PASSPHRASE`** environment
variable. It is **never** accepted as a command-line argument, because `argv`
lands in `ps` output and shell history. Minimum length is **12 characters**.

> **Keep your passphrase.** There is no recovery path — the passphrase is the
> only key to your archive. If you lose it, the backup is unrecoverable by
> design.

## Usage

```bash
export SKYTWIN_BACKUP_PASSPHRASE='choose-a-long-passphrase'

# Export one user's data to an encrypted file
pnpm --filter @skytwin/db backup export --user <userId> --out my-twin.stbk

# Restore an archive onto a fresh install
pnpm --filter @skytwin/db backup restore my-twin.stbk
```

Once `@skytwin/db` is built, the `skytwin-backup` bin is also available
directly:

```bash
skytwin-backup export --user <userId> --out my-twin.stbk
skytwin-backup restore my-twin.stbk
```

Both commands connect to the database via the standard `@skytwin/db`
connection config (`DATABASE_URL` or the per-piece `DATABASE_*` env vars — see
[`docs/cockroach-architecture.md`](cockroach-architecture.md)).

## Restore semantics — fresh install only

`restore` targets a **fresh install**. If a user with the same id already
exists, the restore **refuses** (`user_exists`) rather than clobbering live
data. The entire restore runs inside one transaction, so either the whole twin
lands or nothing does — there is no half-restored state.

To restore over an existing install, delete the user first (the
**Delete my data** flow / `userPurgeRepository`) and then restore. The
delete-then-restore pairing is intentional and mirrors the GDPR data-management
story.

The schema version is checked before any write: an archive produced by a newer
build (higher `BACKUP_SCHEMA_VERSION`) is rejected with `unsupported_schema`
rather than partially imported.

## Exit codes

`skytwin-backup` exits `0` on success and non-zero on any failure (missing
passphrase, missing/short passphrase, user not found, unreadable archive, wrong
passphrase, schema mismatch, existing user). Failures print a human-readable
reason to stderr.

## Implementation reference

| Concern | File |
|---------|------|
| CLI orchestration (testable, IO-injected) | [`packages/db/src/bin/backup-cli.ts`](../packages/db/src/bin/backup-cli.ts) |
| Collect + restore (uses the repository layer) | [`packages/db/src/backup/backup.ts`](../packages/db/src/backup/backup.ts) |
| Encrypted archive codec | [`packages/db/src/backup/archive.ts`](../packages/db/src/backup/archive.ts) |
| Tests | `packages/db/src/__tests__/backup-*.test.ts` |
