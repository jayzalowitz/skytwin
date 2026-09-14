# ADR 0001: Local source-field encryption and locked-state contract

- Status: **Accepted design — implementation and public claims remain blocked on the verification gates below**
- Date: 2026-09-10
- Issue: [#634](https://github.com/jayzalowitz/skytwin/issues/634)
- Inventory: [`docs/security/encryption-field-inventory.json`](../security/encryption-field-inventory.json)
- Implementation status: [`docs/security/source-key-broker-implementation.md`](../security/source-key-broker-implementation.md)
- Decision owners: security and desktop/runtime maintainers

## Context

SkyTwin stores its source-of-truth records in CockroachDB. The packaged desktop
runs a loopback-only, `--insecure` single-node database in the Electron user-data
directory. `--insecure` describes the local SQL transport and database
authentication; it provides no encryption for copied database files. See
[`CockroachManager`](../../apps/desktop/src/cockroach-manager.ts) and the
[`@skytwin/db` connection setup](../../packages/db/src/connection.ts).

Encryption building blocks exist, but the application does **not** currently
provide a general at-rest source-field guarantee:

| Current code                                                                            | What is true today                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@skytwin/credential-vault`](../../packages/credential-vault/src/)                     | AES-256-GCM, scrypt derivation, and an in-process one-hour `KeyCache` exist. Cached buffers are not a cross-process key service.                                                                                                                                          |
| [migration 032](../../packages/db/src/migrations/032-encrypted-oauth-tokens.sql)        | OAuth ciphertext columns and passphrase-verifier metadata exist beside nullable plaintext columns.                                                                                                                                                                        |
| [migration 066](../../packages/db/src/migrations/066-encrypt-high-value-tables.sql)     | Ciphertext siblings exist for selected preference, profile, and `brain_pages` fields. Plaintext siblings remain.                                                                                                                                                          |
| [migration 073](../../packages/db/src/migrations/073-source-key-registry.sql)           | The recovery-wrapper registry and content-free device-wrapper deletion intent exist. They establish custody metadata only; no production source field is encrypted.                                                                                                      |
| [migrations 074–079](../../packages/db/src/migrations/074-inference-receipts.sql)         | The user-child receipt tables store signed structured records and atomic completion authority with no dedicated prompt/response fields. Decision-event ingestion creates and finalizes receipt batches with either configured or ephemeral recorder identity; other application clients and product bundle export remain uncovered. Free-form strings cannot be proven free of source content or secrets, so the JSON is treated as potentially source-bearing. It is locally readable and not application-level encrypted. |
| [`DbTokenStore`](../../packages/connectors/src/oauth/db-token-store.ts)                 | It can decrypt or lazily migrate OAuth rows when its process has a key. The worker's cache is never populated by API unlock, and API OAuth callbacks still write plaintext through [`oauthRepository`](../../packages/db/src/repositories/oauth-repository.ts).           |
| [`TwinRepositoryAdapter`](../../packages/db/src/adapters/twin-repository-adapter.ts)    | Preference encryption is opt-in through a process-global provider. No production composition root calls it, profile fields are still plaintext, and direct backup SQL bypasses it.                                                                                        |
| [`brain_pages` repository](../../packages/memory-gbrain-crdb-adapter/src/repository.ts) | Source text, generated tsvector, vectors, and metadata are readable from the database. The migration's ciphertext columns are not used.                                                                                                                                   |
| [`PassphraseVault`](../../apps/desktop/src/passphrase-vault.ts)                         | The desktop can persist a versioned `safeStorage` ciphertext tagged with the reviewed secure OS credential backend that wrote it; Linux `basic_text`, unknown, unavailable, legacy-untagged, and backend-mismatched records fail closed and are deleted. The renderer can request the plaintext passphrase, then sends it to the API over loopback HTTP. This is not the target broker design below. |
| [`credential-vault` routes](../../apps/api/src/routes/credential-vault.ts)              | API-only init/unlock/lock works for the API cache. Rotation re-encrypts encrypted OAuth rows only; it does not rotate any preference, profile, or memory ciphertext.                                                                                                      |
| [`DesktopKeyBroker`](../../apps/desktop/src/key-broker.ts)                              | The custody kernel implements recovery/device wrappers, purpose-separated keys, context-bound envelopes, child capabilities, and a lock barrier. Production composition still uses a temporary Electron-store adapter rather than the CockroachDB registry.               |
| [`ServiceManager`](../../apps/desktop/src/service-manager.ts)                           | Electron main attaches the API and worker children to the broker, but deliberately gives both empty owner grants. No production source operation can request a key through this foundation.                                                                               |
| [`skytwin-backup`](../backup-restore.md)                                                | The selected export is encrypted as a whole with a separate passphrase, but collection reads raw repository rows. It is not yet compatible with a completed source-field migration. Credentials are excluded.                                                             |
| [User purge route](../../apps/api/src/routes/users.ts)                                  | The current API transaction purges user-owned database rows, and the dashboard clears its own `localStorage`. It does not coordinate deletion of the desktop's remembered-passphrase entry, so cross-store deletion is a target requirement rather than current behavior. |

The database also contains secrets and source content outside those four
partially prepared tables: provider API keys, service credentials, MCP
environment maps, federation private keys, decision and explanation payloads,
assistant messages, signals, histories, both memory backends, exports, and
dead-letter context. Execution results and spend records are included as action
receipts, not treated as harmless operational data. The machine-readable
 inventory classifies all 994 columns across the 104-table live schema as of
 `079-inference-receipt-capture-order.sql`; validation fails when a table or column is
missing or duplicated. It reconstructs the same schema-plus-sorted-SQL
sequence used by the production
[`001-initial` migration runner](../../packages/db/src/migrations/001-initial.ts).
That runner sends both its development and desktop-owned entry points through
one ordered migration flow. Migration 071's worker-generation table is an
installation-scoped, ephemeral authorization boundary: it stores lifecycle
metadata and a one-way verifier of a random process credential, not recoverable
source, and is excluded from portable backup.
Migration 073's recovery wrapper and KDF record are explicitly exposed
cryptographic metadata: a copied wrapper permits offline passphrase guessing.
Its deletion-intent table contains no key material and exists so future
cross-store cleanup can retry after the user row and registry have been removed.
Migration 074's canonical receipt JSON is also explicitly exposed. It can
reveal which provider, model, endpoint, cost or billing identity, and
verification/fallback path were used. The schema has no dedicated request or
response fields, but free-form strings cannot be proven free of source content
or secrets; the inventory therefore classifies the JSON as deferred source
data. Keeping the signed record readable currently enables integrity
verification, audit, backup, and deletion; it does not establish an encryption
claim. The [receipt guide](../inference-receipts.md) discloses the decision-event
create caller, configured-or-ephemeral recorder behavior, and the remaining lack
of coverage for other application clients, product bundle export, and receipt
detail UI.

Filesystem and process-local surfaces are separate from the SQL inventory:

- `<userData>/crdb-data` contains CockroachDB data, indexes, and WAL.
- `<userData>/crdb-logs` may contain operational errors and must never receive
  decrypted content or secrets from application logs.
- `<userData>/secrets/session-secret` and `service-token` are random secrets
  stored in plaintext owner-readable files (`0600`) by
  [`ServiceManager`](../../apps/desktop/src/service-manager.ts).
- `skytwin-passphrase-vault` stores versioned, backend-tagged `safeStorage`
  ciphertext only with a reviewed secure OS credential backend. Once Electron
  is ready, startup removes legacy-untagged, unsupported, and backend-mismatched
  records across users without decrypting them. The target replaces remembered-
  passphrase storage with a device-wrapped random user key.
- The dashboard currently stores a session token in renderer `localStorage`.
- `.dxt` exports are plaintext with an unkeyed SHA-256 checksum, so they are not
  confidential or authenticated against deliberate modification; their
  serializer redacts known secret-shaped arguments. `.stbk` backup archives are
  separately passphrase-encrypted and authenticated.

This ADR defines an application-level source-field boundary. It does not claim
whole-database encryption, encrypted search, protected process memory, or a
confidential unlocked host.

## Threat model and guarantee

### In scope

1. **Stolen or offline disk.** A copy of `crdb-data`, WAL, or an ordinary disk
   image must not reveal fields classified `encrypted_source` after their
   migration is complete and verified.
2. **Copied database directory.** The database copy does not include the
   OS-protected device wrapper. Its passphrase wrapper is subject to offline
   password guessing, so the KDF and passphrase policy are part of the boundary.
3. **Copied backup.** A `.stbk` archive is independently authenticated and
   encrypted. Raw database backups retain the same source/derivative split as
   the live database and do not include device key material.
4. **Opportunistic malicious local process while locked.** No key, passphrase,
   or plaintext compatibility environment variable is exposed. A process that
   can only read files sees ciphertext plus the explicitly exposed metadata and
   derivatives.
5. **Crash, restart, or partial migration.** Missing keys and mixed row states
   produce typed failures or resumable work, never a silent plaintext write,
   empty substitution, ciphertext response, or false success.

### Outside the at-rest guarantee

- A compromised OS account or process while SkyTwin is unlocked can observe
  plaintext that an authorized API or worker operation legitimately uses.
- Kernel compromise, memory scraping, screen capture, input capture, Electron
  renderer compromise during passphrase entry, and malicious replacement of
  the running binaries require OS hardening, sandboxing, and release signing.
- Data sent to an explicitly configured model, embedding service, connector,
  MCP server, or execution provider follows that provider's network and data
  policy. Local at-rest encryption does not make a remote call confidential.
- Locally readable indexes, embeddings, graph fields, identifiers, timestamps,
  lengths, status values, and access patterns leak information as disclosed in
  the inventory.
- Files that a user explicitly exports are protected according to that export
  format, not by the live database boundary.

## Decision

### 1. Encrypt source fields, disclose derivatives and metadata

Each live SQL column belongs to exactly one inventory classification:

| Classification               | Contract                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `encrypted_source`           | In the first applicable migration slice. A completed row stores only an authenticated envelope for this source value.                                                                        |
| `deferred_source`            | Inside the decided boundary, but scheduled after the first slices. It remains a launch claim blocker until its stated stage is complete or the public claim is narrowed.                     |
| `locally_exposed_derivative` | Remains readable for search or graph operations and is rebuildable from source. It never inherits the source-field encryption claim.                                                         |
| `locally_exposed_metadata`   | Remains readable for joins, scheduling, migration, deletion, and audit. Identifiers, timestamps, types, sizes, and relationships can still be revealing.                                     |
| `one_way_secret`             | Stores a digest/verifier, not recoverable ciphertext. Domain separation and comparison safety still apply.                                                                                   |
| `excluded_operational`       | Current global/curated operational data, with a rationale. It must be reclassified if user content or a credential enters it.                                                                |
| `forbidden_global_source`    | Source-bearing data found in a system-global row that is prohibited in the target. It must be redacted, deleted, or moved to a user-owned encrypted row, never encrypted under a global key. |

The checked-in inventory, not an informal table list in this ADR, is the schema
coverage source of truth. A migration that adds or removes a field must update
the inventory in the same PR.

Ownership is a strict enum: `user`, `user_child` (resolved through a repository
join to its parent), `installation`, or `system_global`. Current and target
repository boundaries are also enums. Every table carries `auditedCallsites`, a
repository-relative list from a conservative scan of supported literal SQL
string and template shapes in `.ts`, `.js`, and `.mjs` files under `packages/`
and `apps/`, plus validated annotations for the recognized dynamic seed
patterns. The scan covers files containing `query(...)` calls and literal table
references following its supported SQL verbs; the `seedUpsert` annotation is
bound to its runtime allowlist. Matches include direct API/worker queries,
backup code, and seeds. Empty lists mean `no_runtime_sql_found` by those
supported patterns, not that the table is unused. The validator requires finite
annotations for the dynamic template and seed forms it recognizes; differently
assembled SQL must extend the validator and inventory in the same change.

Randomized envelopes cannot preserve SQL equality, uniqueness, range, or prefix
queries. The inventory's `searchableDerivatives` arrays name only separate
derivative columns that exist today; an empty array does not imply that the
plaintext source is never used by a current query or constraint. Before each
domain migration, its repository audit must replace every such dependency with
one of these explicit choices:

1. route by an already exposed opaque identifier;
2. decrypt a bounded per-user candidate set in the authorized process; or
3. add a versioned, purpose-keyed HMAC-SHA-256 equality index over a canonical
   value and classify it `locally_exposed_derivative` in the inventory.

The third option is appropriate only for required exact lookup or uniqueness,
including current patterns around user email, OAuth/provider account identity,
preference domain/key, transient auth state, pairing codes, service credential
keys, and indexed file paths. Its HMAC input binds table, source column, owner,
normalization version, and value. A uniqueness migration computes and verifies
the new index before replacing the plaintext constraint. The keyed index resists
offline dictionary testing without the lookup key, but still leaks equality and
frequency and is available to a compromised unlocked broker. The beta does not
add range, prefix, or full-text indexes over protected source.

Pre-identity lookups where a user key cannot yet be selected (for example, user
email used to resolve an owner, transient OAuth state, or a pairing code) use a
distinct IRK-derived lookup purpose and stable installation owner ID, or are
redesigned to avoid persisted lookup. They are unavailable across restart when a
genuine OS secret backend is unavailable; a plaintext or unkeyed low-entropy
lookup digest is not a fallback.

### 2. Use random user roots and purpose-derived data keys

The current passphrase-derived key must not remain the data-encryption key.
The target hierarchy is:

```text
user passphrase --versioned memory-hard KDF--> passphrase wrapping key
OS secret store ----------------------------> device wrapping operation

random 256-bit user root key (URK, version N)
  wrapped by passphrase key -> database key registry
  wrapped by OS key         -> device-local remembered-unlock record
  HKDF-SHA-256(URK, purpose, version) -> purpose data-encryption key (DEK)

random 256-bit installation root key (IRK, version N)
  wrapped only by the OS secret store -> device-local record
  HKDF-SHA-256(IRK, purpose, version) -> installation-purpose DEK
  -> restart-resumable pre-identity auth and explicitly installation-owned secrets
```

- Generate each URK with the operating system CSPRNG. Never derive it directly
  from identity, passphrase, installation secret, or another user's key.
- Derive separate DEKs for `credentials`, `twin`, `activity`, `memory`, and
  `portable_config`. The HKDF `info` includes the application, user, purpose,
  envelope version, and URK version.
- The passphrase KDF record carries algorithm and parameters. The first beta
  implementation may retain built-in scrypt for packaging reliability, but
  must benchmark a memory-hard setting on supported platforms and version it so
  parameters can be raised. A bare SHA-256 passphrase verifier is not a wrapper.
- Store passphrase-wrapped URKs and version/state metadata in CockroachDB. Store
  device-wrapped URKs in the Electron user-data store; the OS secret is not in
  the database or backups.
- On Linux, remembered unlock is allowed only when Electron reports a genuine
  secret-service backend. `basic_text` or an unavailable backend is manual
  unlock, never a weaker persistence fallback.
- Replace "remember my passphrase" with "remember this device": `safeStorage`
  wraps the random URK. The passphrase is never persisted or returned from the
  main process to the renderer after entry.
- Pre-identity transient state such as a persisted PKCE verifier cannot use a
  user key yet. A separate random IRK protects that narrow purpose. It is not a
  fallback user key, is not exported, and is regenerated on device reset; an
  unavailable genuine OS secret backend means restart-resumable pre-identity
  state is disabled.
- `service_credentials`, dynamically populated `credential_requirements`, and
  dynamically discovered `ironclaw_tools` are installation-owned for the beta.
  Before slice 1, each table gains a non-null stable `installation_id`; its
  private text/config fields use distinct IRK purposes. They are excluded from
  portable backup. Restore, device reset, or IRK loss deletes the unusable local
  rows and requires credential reconfiguration or capability rediscovery.
  Identifier-based deletion remains possible while locked. Installed service
  names, row counts, timestamps, and safety flags that remain metadata disclose
  which capabilities may be present.
- `worker_dead_letter` remains system-global and becomes content-free before
  slice 1. The global row may contain stable job/error codes, attempts,
  timestamps, and opaque record IDs only. Required user payload moves to a new
  user-owned record with `user_id`, lifecycle deletion, and a user-purpose
  envelope; otherwise it is redacted or deleted. Encrypting a global payload
  under an installation key is rejected because it would defeat per-user purge
  and ownership.

### 3. Use a self-describing, context-bound envelope

New ciphertext uses AES-256-GCM with a fresh 96-bit nonce and a 128-bit tag.
The envelope contains a magic/version, algorithm, purpose, root-key kind and
version, nonce, tag, and ciphertext. Authenticated additional data binds:

```text
application | envelope-version | owner-kind | owner-id | purpose |
key-version | table | column | stable-row-id
```

Binding context prevents a valid ciphertext from being swapped between owners,
rows, tables, or fields. For user-owned data, the owner ID is the user ID; the
narrow installation-owned cases use a stable installation ID. Ciphertext fields
carry their own key version; one row version shared by multiple independently
rotated values is insufficient. The legacy `[iv][tag][ciphertext]` payload is
read only during an explicit migration state and is never written by the
completed design.

JavaScript strings cannot be reliably zeroized. Key material stays in `Buffer`
instances and is overwritten on eviction where possible. Plaintext lifetimes
must be bounded, but the public guarantee must not claim memory erasure.

### 4. Make Electron main the packaged key broker

In the packaged desktop, Electron main owns unlock state and cryptographic
operations. API and worker children do not receive raw keys or passphrases.

- `ServiceManager` creates a private Node child-process IPC channel for API and
  worker. It does not serialize key material into `env`, argv, URLs, logs,
  renderer storage, or CockroachDB.
- On spawn, the broker binds a one-time capability to the concrete child and
  its role. Only API and worker receive it; web/renderer does not.
- Children request `encrypt`, `decrypt`, `rewrap`, or `state` for a user,
  purpose, table, column, and row. The broker authorizes role/purpose, performs
  crypto, and returns only the operation result. Decrypt necessarily returns
  authorized plaintext to the requesting child; it never returns a DEK or URK.
- Requests and logs contain opaque request IDs and content-free byte counts,
  key versions, outcomes, and error codes. They never contain passphrases,
  keys, plaintext, ciphertext, or provider tokens.
- A broker generation number and per-user lock barrier invalidate queued work
  after lock. Children must treat disconnect or generation mismatch as locked.
- The beta broker expires each cached URK 60 minutes after unlock, matching the
  current cache's fixed default TTL. Expiry runs the same barrier as explicit
  lock. Health checks and child requests cannot silently unwrap a remembered
  key after expiry; a subsequent unlock is an explicit user action.
- The existing loopback service token authenticates HTTP ingest; it is not a
  key-wrapping key and is never reused as one.

Standalone/headless API and worker operation is **not** covered by the first
packaged-beta encryption claim. An encryption-required database starts locked
unless a future local broker (owner-only Unix socket / Windows named pipe with
peer authentication) is explicitly configured. It must never fall back to
`provider === null` plaintext mode or accept a data key in an environment
variable. A worker without a broker runs non-sensitive health/deletion work and
defers protected jobs with `vault_locked`; it does not consume encrypted jobs as
empty data.

### 5. One repository gateway, no plaintext compatibility mode

The target `@skytwin/db` boundary exposes typed protected-field operations and
requires broker context for every field classified as source. Domain
repositories remain responsible for schema and transaction semantics; the
gateway is responsible for envelopes and locked-state errors.

- OAuth writes from callback, refresh, worker, disconnect, and rotation converge
  on one credential repository path.
- Profile and profile-version writes are migrated together. A snapshot cannot
  be left plaintext while the current profile is encrypted.
- Memory writes cover both gbrain and MemPalace source fields. Search derivative
  creation happens from authorized plaintext, then the plaintext source is
  discarded from the write process as soon as practical.
- Backup restore, seeds used outside demo-only databases, imports, and admin jobs
  cannot issue direct plaintext SQL for protected columns.
- Protected writes are ciphertext-only after their stage gate. `NULL`, empty
  JSON, or an omitted value is not a substitute for a key failure.
- CI scans SQL call sites for classified columns and requires an explicit,
  reviewed escape hatch for migration/verifier code. Database constraints are
  added after backfill to prevent a future direct plaintext write.

The current `resolveKey(null) -> plaintext` behavior is compatibility code, not
part of the target contract.

## Locked-state contract

All expected protection failures use typed results. HTTP may map
`vault_locked` to `423 Locked`; background jobs persist only content-free retry
metadata. The canonical error family is:

- `vault_uninitialized`
- `vault_locked`
- `vault_broker_unavailable`
- `key_version_unavailable`
- `ciphertext_invalid`
- `migration_pending`
- `rotation_in_progress`

| Operation while locked             | Required behavior                                                                                                                                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected read                     | Return `vault_locked`; never return ciphertext, placeholder, stale cache, or partial object.                                                                                                                                 |
| Protected write/update             | Reject before SQL mutation. No plaintext fallback and no partial-success response.                                                                                                                                           |
| Background job                     | Release/extend its lease and record a content-free deferred reason. It must not increment a destructive-attempt counter.                                                                                                     |
| Search                             | May score exposed derivatives, but may not return source snippets/titles. Return a locked result with only explicitly exposed metadata, or require unlock for the whole endpoint.                                            |
| Twin/DXT export                    | Require unlock. Mark the result sensitive and write through the format-specific protection step.                                                                                                                             |
| `.stbk` backup                     | Require unlock to collect source rows. Encrypt the assembled stream under the separate archive passphrase before durable write.                                                                                              |
| Raw database backup                | May copy database files while locked. It contains source ciphertext plus exposed derivatives/metadata and no device wrapper.                                                                                                 |
| Delete/unpair/revoke by identifier | Must remain available without decrypting source. Deletion is not blocked by a lost key. Provider-side revocation that needs a token may be impossible while locked; delete local data and report that limitation explicitly. |
| Health/status                      | Return content-free state and counts only.                                                                                                                                                                                   |

An unlock affects one user. Multi-user installations do not gain an
installation-wide plaintext state.

## Sequence and state flows

### 1. First unlock / initialization

```text
Renderer passphrase input -> preload IPC -> Electron main broker
Broker: create random URK v1 -> derive passphrase wrapper -> store wrapped URK metadata
Broker: if genuine OS secret backend, offer device wrapper (explicit opt-in)
Broker: cache URK Buffer -> bump user generation -> report unlocked (no passphrase echo)
API/worker: observe state through private broker IPC -> resume eligible protected work
```

Initialization is not successful until the wrapped-key row is committed and a
round-trip unwrap self-test succeeds. Failure removes any incomplete device
wrapper and key-registry row.

### 2. Remembered unlock

```text
Desktop start -> safeStorage backend check -> load device-wrapped URK
Broker unwrap + key-registry/version compatibility check + envelope canary
  success -> cache URK -> unlocked
  unsupported/missing/corrupt/mismatch -> delete unusable device wrapper -> manual prompt
```

No remembered passphrase crosses preload IPC. Moving Electron store files to a
different OS account must fail the unwrap and fall back to manual unlock.

### 3. API and worker key access

```text
Child protected operation -> private IPC {role, user, purpose, row context, op}
Broker checks child capability + user state + generation + purpose
  unlocked -> derive purpose DEK -> perform crypto -> return typed result
  locked/disconnected/version missing -> typed failure; child performs no source SQL write
```

### 4. Explicit lock, cache expiry, and mid-operation lock

```text
User lock or 60-minute cache expiry -> broker closes admission -> generation increments
Broker cancels queued crypto -> waits for admitted operations to finish or abort
Children acknowledge barrier -> broker zero-fills cached key Buffers -> locked response
```

The UI must not display "locked" before the barrier completes. A DB transaction
that already contains plaintext must commit a ciphertext-only mutation or roll
back; it cannot be converted to a placeholder response.

### 5. Restart

```text
Process restart -> all in-memory keys absent -> user state locked
Device wrapper valid -> remembered-unlock flow
No valid wrapper -> API/worker protected operations remain locked until manual unlock
Child crash/restart -> new child capability + current broker generation; old channel invalid
```

### 6. Data-key and passphrase rotation

Passphrase rotation rewraps every retained URK under a new passphrase key. It
does **not** rewrite every data row. Data-key rotation is separate:

```text
Create random URK N+1 in preparing state; keep wrapped URK N
Set write version N+1; read set {N, N+1}
Re-encrypt rows in bounded, resumable batches with compare-and-set
Verify each new envelope and inventory counts; record content-free checkpoints
Mark N+1 active/complete -> recovery drill + soak -> retire wrapper N
```

Crash recovery resumes from row/version checkpoints. Rollback before retirement
sets N as write version and reverses N+1 rows while both wrappers exist. After
old-wrapper destruction, rollback to software that only understands N is
forbidden.

The existing API rotation endpoint cannot be extended as-is: changing the
passphrase-derived key after rotating OAuth alone would strand any preference,
profile, or memory ciphertext encrypted under the old derived key.

Keyed equality indexes rotate independently from source envelopes. The decided
schema uses a normalized registry rather than an ambiguous single digest column:

```text
lookup_index_definitions(
  index_id, owner_kind, normalization_version,
  active_key_version, pending_key_version, state
)
protected_lookup_entries(
  index_id, owner_id, row_id, normalization_version,
  lookup_key_version, digest
)
UNIQUE(index_id, owner_id, normalization_version, lookup_key_version, digest)
UNIQUE(index_id, owner_id, row_id, normalization_version, lookup_key_version)
```

`state` is `active`, `preparing`, `backfilling`, `verifying`, `dual_read`, or
`retiring`. The definition row is the serialization point for equality and
uniqueness; one `index_id` describes the canonical scalar or composite value
covered by a logical lookup/constraint. During N to N+1 rotation:

1. Create the N+1 lookup key and set `pending_key_version=N+1`; all new writes
   produce entries for both N and N+1.
2. Backfill N+1 entries in resumable owner/row batches. Recompute from
   authorized plaintext and verify the stored digest; never transform an N
   digest into N+1.
3. For lookup, compute both versioned digests and query both tuples. Deduplicate
   by `row_id`; disagreement or two different rows is a typed
   `lookup_uniqueness_conflict`, not an arbitrary winner.
4. For insert/update of a unique logical value, compute digests for the versions
   named by the definition epoch, then start a serializable transaction, lock
   the definition row, verify its epoch is unchanged, query **all readable
   versions** for another row, and atomically write the source envelope plus all
   required lookup entries, replacing the row's old digests on update. Retry
   serialization failures. Old binaries that do not understand the dual-write
   state refuse startup. Per-version SQL unique constraints backstop
   same-version races; the locked cross-version check prevents N-only and
   N+1-only duplicates.
5. Verify one entry per source row/version, canonical-value round trips, and no
   cross-version conflicts. Switch `active_key_version` to N+1 while retaining N
   reads through the soak and restore drill, then enter `retiring` and delete N
   entries/key material only after the gate passes.

A crash resumes from the definition state and row checkpoint. Before N retires,
rollback restores N as active, resumes N writes, removes verified N+1 entries,
and discards the pending key. After N entries or key material are destroyed,
rollback to N is forbidden. Tests must cover concurrent equal inserts, an
existing logical duplicate discovered during backfill, conflict across N/N+1,
crash at each state transition, restart in dual-read, rollback before retirement,
and refusal after retirement.

### 7. Migration and resume

```text
Stage schema + v2 writer -> set user/domain state pending
Backfill batch: read plaintext -> encrypt -> local decrypt/compare -> store ciphertext
Verifier batch: read stored ciphertext + plaintext -> decrypt/compare -> mark verified
Clear plaintext only for verified rows -> advance content-free checkpoint
Crash -> lease expires -> resume by user/domain/stable primary key
Soak + backup/restore exercise -> add ciphertext-only constraints -> later drop plaintext
```

Backfill is per-user, idempotent, rate-limited, and observable by counts, bytes,
versions, durations, and error codes only. Fire-and-forget lazy migration on a
normal read is rejected. The verifier must compare canonical JSON where source
columns are JSONB and must never clear recoverable plaintext in the same step
that first writes unverified ciphertext.

### 8. Backup export and restore

```text
Export: unlock -> repository-domain reads -> stream plaintext into `.stbk` encoder
        -> authenticated archive durable write -> release plaintext buffers
Restore: decode + authenticate archive -> validate schema -> create fresh user URK
         -> repository-domain ciphertext writes + rebuild target lookup entries
         -> verify counts/canaries/lookup uniqueness -> commit
```

`.stbk` excludes OAuth/provider and installation credentials, installation
capability catalogs, device wrappers, URKs, sessions, recovery codes, and pairing
secrets; connectors reauthorize and local capabilities are rediscovered. Restore
never copies live database ciphertext or keyed lookup digests into a new key hierarchy. The current
`SKYTWIN_BACKUP_PASSPHRASE` environment input is legacy behavior; the target CLI
reads from an interactive TTY or inherited secret file descriptor, not argv or
environment. Wrong passphrase, unavailable live-data key, unsupported schema,
or failed re-encryption leaves the destination unchanged.

A raw CRDB backup is different: it preserves row ciphertext, key registry
wrappers, derivatives, and metadata. It excludes the device wrapper by location.
Restore must verify that at least one passphrase/device wrapper can unlock every
referenced key version before declaring the application ready.

### 9. Delete and lost key

```text
Delete request (unlock not required) -> mark local deletion intent
DB serializable purge by identifiers -> remove key registry + ciphertext + derivatives
Desktop removes all device wrappers -> verify both stores -> clear deletion intent
```

Database and OS-store deletion cannot share one transaction, so a durable,
content-free deletion intent makes retries converge. If DB purge succeeds first,
the leftover device wrapper has no ciphertext to unlock; if wrapper deletion
succeeds first, DB purge still works without a key.

If all wrappers for a referenced URK are lost, encrypted source is unrecoverable
by design. Metadata, derivatives, ciphertext, and key records remain deletable.
Reset requires an explicit destructive confirmation, purges the affected user
data and device wrappers, then initializes a new empty key hierarchy. It must not
silently keep undecryptable records or claim that metadata was recovered.

## Search and derivative boundary

`brain_pages.content_tsv` contains lexemes; `brain_pages.embedding` encodes
semantic information; graph entity names and subject/predicate/object values
make relationships readable. Hashes, sizes, timestamps, source types, reference
IDs, row counts, and access patterns add further leakage. Keeping `content`
ciphertext while leaving these values readable is useful source-field
protection, not encrypted search.

For the beta:

1. Source title/content/metadata is encrypted after the memory slice.
2. Before `brain_pages.metadata` encryption is enforced, `authoringTier` and
   `userOverride` move to typed locally exposed columns, while `fromAddress`
   equality moves to a versioned purpose-keyed HMAC index. These projections
   preserve filtering, backfill, weighting, and pin/hide behavior and explicitly
   disclose their leakage. `lifebooks.metadata.importanceOverride` instead
   requires unlock and bounded in-process evaluation; it does not stay readable.
3. Existing tsvectors, embeddings, and classified graph derivatives remain
   local and readable, are rebuilt from source, and are deleted with the user.
4. Remote embedding is an explicit provider/network disclosure. The source is
   decrypted only for the authorized request; provider output remains an
   exposed local derivative.
5. Locked search may return only the inventory-approved metadata. Snippets,
   source titles, and reconstructed graph prose require unlock.
6. Product copy says "selected source fields encrypted at rest; local search
   derivatives and selected operational metadata remain readable," never "all
   data encrypted" or "encrypted memory/search."

Searchable encryption, ORAM, and confidential database execution are deferred
research, not beta dependencies.

## Implementation slices

Each slice is independently fail-closed and lands with focused migration,
repository, broker, restart, corruption, delete, and backup tests.

Before slice 1 can encrypt a source field, its ownership gate must pass. The
gate adds and backfills `installation_id` on the three installation-owned tables,
proves reset/restore behavior, makes the global DLQ content-free, and migrates
any retained user failure payload into a user-owned table. It is part of the
architecture-enforcement work following slice 0, not an optional choice inside
slice 1.

0. **Key broker and envelope, no production source migration.** Add the key
   registry, v2 envelope/AAD library, Electron broker, device wrapper, typed
   state API, and crash/lock tests. Keep claims blocked. This is the smallest
   safe first slice because it proves recoverable key custody before creating
   new ciphertext.
1. **Secrets and portable configuration.** Converge OAuth writes; migrate OAuth,
   provider API keys, installation-owned service credentials and dynamic
   capability descriptions, MCP config/env, federation private keys, OAuth
   transient verifiers, DXT database blobs, and connector cursors. Remove source
   content from the global DLQ rather than encrypting it there. Prohibit
   plaintext writes for completed owners/domains.
2. **Twin state.** Migrate preferences, current profiles, profile versions,
   risk profiles, proposals/history, traits, patterns, and identity source
   fields. Remove the dormant process-global preference provider.
3. **Activity and conversation.** Migrate signals, decisions, candidates,
   outcomes, explanations, approvals, feedback, execution payloads, assistant
   history, briefings, watches, policy source, and related summaries.
4. **Memory sources.** Migrate gbrain and MemPalace source fields and Lifebooks;
   retain and disclose classified search/graph derivatives.
5. **Remaining user content and constraints.** Resolve every `deferred_source`,
   run restore/recovery/rotation exercises, add ciphertext-only constraints,
   and remove plaintext columns only after soak.
6. **Claim enablement.** Update the release claim ledger only when artifact-backed
   tests identify the exact completed fields/platforms and all stop-ship entries
   are satisfied.

Headless broker support is a separate slice and claim. It must not delay the
desktop boundary or weaken it through environment-delivered keys.

## Rollout and rollback

- Feature state is per user and purpose: `disabled`, `pending`, `backfilling`,
  `verifying`, `enforced`, or `error`. Only `disabled` permits legacy plaintext
  writes, and only before that purpose begins migration.
- New installations may enable ciphertext-only writes after broker
  initialization; existing installations use explicit backfill.
- Read order during migration is verified v2 envelope, legacy envelope, then
  plaintext only when the user's domain state explicitly permits it.
- A binary that does not understand the database's enforced envelope version
  refuses startup. It never "rolls back" by treating ciphertext as absent.
- Software rollback is supported through the verifying/soak window while
  plaintext and old wrappers are retained. Plaintext removal and old-key purge
  are separate, manually gated migrations after a restore exercise.
- A kill switch stops migration and new protected work; it does not re-enable
  plaintext writes for an already enforced user/purpose.

## Rejected alternatives

| Alternative                                                                              | Reason rejected                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Rely only on FileVault, BitLocker, or filesystem permissions                             | Valuable defense, but copied database files and backups need an application-level, testable boundary.                                           |
| Claim CockroachDB `--insecure` local storage is encrypted                                | It is not an at-rest control.                                                                                                                   |
| Require a paid database/TDE feature                                                      | Does not meet the open beta deployment constraint and still would not define exports, logs, or unlocked processes.                              |
| Derive the data key directly from the passphrase                                         | Passphrase change would require rewriting all data; random URKs allow cheap rewrap and independent data-key rotation.                           |
| One installation-wide key                                                                | A single compromise crosses users and prevents per-user lock/delete/rotation.                                                                   |
| Put raw keys/passphrases in environment variables, argv, URLs, renderer storage, or logs | These surfaces are ambient, inspectable, persistent, or routinely captured.                                                                     |
| Send raw DEKs to API/worker children                                                     | Broadens key custody and makes lock/restart guarantees harder. Brokered operations expose only authorized plaintext results.                    |
| Transparent SQL/ORM middleware                                                           | Cannot distinguish source from derivatives, preserve domain transaction semantics, or prevent direct-query bypasses reliably.                   |
| Lazy migration on reads                                                                  | Non-deterministic, fire-and-forget, difficult to verify, and unsafe for plaintext removal or backup completeness.                               |
| Deterministic/searchable encryption for current search                                   | Leaks equality/frequency, complicates ranking, and does not solve embedding leakage. Disclosed local derivatives are the honest beta trade-off. |
| One unversioned blind-index digest column                                                | Key rotation would split logically equal values across incomparable digests and allow cross-version uniqueness violations.                      |
| Encrypt global dead-letter payloads with the installation key                            | Makes user-derived failures survive per-user purge and leaves ambiguous ownership; global DLQ state must be content-free.                       |
| Encrypt opaque JSON blobs without AAD context                                            | Permits valid ciphertext swapping and makes field/version audits ambiguous.                                                                     |
| Block deletion while locked                                                              | A lost key must not make personal data undeletable.                                                                                             |

## Consequences

Positive consequences:

- Offline copies lose direct access to migrated source fields without a valid
  wrapper, while local retrieval remains useful.
- Passphrase changes become key rewraps; data-key rotation remains explicit and
  crash-recoverable.
- API and worker have a testable locked state without ambient secrets.
- Schema changes cannot silently escape classification.

Costs and limitations:

- Repository methods become asynchronous broker clients and need more failure
  branches, transaction care, and integration tests.
- Search derivatives and metadata continue to leak information locally.
- An unlocked or compromised child receives plaintext required for its work.
- Multi-resource device-wrapper/database deletion and rotation require durable
  state machines.
- Legacy backups, direct SQL, and current rotation code require replacement or
  explicit migration handling.

## Verification and claim gate

The ADR and inventory can be checked without a database:

```bash
pnpm check:encryption-inventory
git diff --check
```

The validator proves structural facts only: table and column coverage derived in
the production migration runner's declared order, strict enum membership,
realpath-contained regular-file references with symlinks rejected, exact
agreement with its conservative scan's supported matches and validated dynamic
SQL annotations, and resolvable declared derivatives. Reviewed SHA-256 baselines
pin the exact migration runner, schema-plus-sorted-migration corpus, and
per-field semantic manifest. Changing runtime migration flow or SQL, or an
owner, class, boundary, stage, protection statement, rationale, derivative, or
documented operational dependency, therefore requires an explicit baseline
diff. Critical credential/DLQ invariants and metadata dependency resolutions are
also hardcoded and mutation-tested.

It does **not** prove that a human classification is correct, that a repository
is safe, or that every runtime query was found. The callsite scan includes seeds
and strips comments to avoid prose-only matches. It recognizes only literal
verb/table pairs and the explicitly annotated seed helpers; other dynamic table
identifiers, generated/external code, stored procedures, and differently
assembled SQL can escape it. Security review must combine the list with
repository tracing and direct-SQL review; passing automation is not
implementation or security evidence.

Implementation PRs must additionally prove, with fresh-database and upgrade
tests:

- no classified source write occurs while locked or without the broker;
- envelope context swapping, wrong keys, corruption, and missing versions fail;
- first/manual/remembered unlock, restart, child restart, and explicit lock;
- migration crash at every state resumes without clearing unverified plaintext;
- passphrase rewrap and data-key rotation rollback while old wrappers remain;
- lookup-key rotation dual-reads N/N+1, rejects concurrent and cross-version
  logical duplicates, resumes every transition, rolls back before retirement,
  and refuses rollback after N destruction;
- `.stbk` and raw-DB restore compatibility checks;
- delete succeeds with the vault locked and after key loss;
- logs, metrics, errors, and DLQ records contain no fixture secrets;
- packaged tests run on macOS, Windows, and Linux, including no-secret-service
  Linux behavior.

Public encryption claims stay blocked until those artifacts exist. This ADR,
the presence of ciphertext columns, and passing inventory validation are design
evidence only, not implementation evidence.

## Accepted beta product policies

The architecture and security review resolved the remaining policy choices as
follows:

1. A passphrase wrapper is mandatory for every desktop-beta user key. A
   device-only mode is not supported. Remembering a device is an additional
   wrapper, not the only recovery path.
2. Routine key rotation retains the prior wrapper and raw recovery material
   until a restore drill succeeds and the new key has completed at least seven
   consecutive days without a key-version, decrypt, migration, or lookup-index
   integrity alert. Incident-response rotation may shorten the soak only with
   an explicit security-owner record after the restore drill; automation never
   makes that exception.
3. Headless encrypted operation is outside the desktop beta support matrix. A
   headless process encountering an encryption-required database remains
   locked until an authenticated local broker is implemented and separately
   verified.
4. Exported DXT files remain intentionally plaintext after secret redaction for
   the beta and provide integrity, not confidentiality. Export UI and docs must
   disclose that boundary. Database-resident DXT source fields are still in the
   protected source-field boundary; an optional recipient/passphrase envelope
   for exported files is deferred.
