# Source-key broker implementation status

This change establishes part of the source-field encryption architecture. It
does **not** enable an at-rest encryption claim and does not migrate any
production source field.

The implemented kernel provides a random per-user root, a versioned mandatory
passphrase recovery wrapper, explicit scrypt parameters, purpose-separated
HKDF data keys, context-bound AES-256-GCM envelopes, strict envelope parsing,
per-child capabilities, role/field/owner authorization, and a one-hour lock
barrier. The renderer surface is restricted to the loopback dashboard, binds a
renderer process to one validated user identifier, rate-limits KDF requests,
and blocks privileged-preload navigation to other origins.

Migration 073 defines the CockroachDB recovery-key registry and durable device
wrapper deletion intent. Production desktop composition now uses that registry
for the mandatory recovery wrapper; the optional device wrapper remains in
Electron's local store. The broker also supports explicit device opt-in, but
only when Electron reports genuine OS protection; corrupt wrappers are removed
and the mandatory recovery wrapper is retained.

Electron gives each API or worker child a random process capability. The API
requests an owner grant only after validating that user's session; the worker
requests grants only for users discovered through its database-backed connector
work. API grants carry the authenticated session deadline over IPC; Electron
stores that deadline and rejects every request after it, independently of the
child's timer. Grants are also removed when the final active session is revoked.
Worker rediscovery sends one capability-authenticated replacement set that the
Electron broker applies atomically, so absent owners are removed at the parent
authority boundary. A failed or unacknowledged reconciliation clears all child
authority and propagates an error; the managed worker then exits and its parent
binding is detached rather than continuing with a stale set. An unacknowledged
API revoke likewise clears child authority, while parent-enforced session expiry
remains the independent backstop. Grants are bound to the child
role, user, purpose, table, and column. A lock closes admission, notifies each
granted child, and briefly drains in-flight calls. A child that does not
acknowledge or drain during lock or unlock is detached and terminated; the root
key is zeroed in a `finally` path. Unlock broadcasts the next generation to avoid stale first
requests. Standalone processes have no parent IPC and remain fail closed.

Registry initialization retains a process-local rollback marker until the
persisted wrapper passes its read-back self-test. Failed cleanup keeps that
marker for retry before the next initialization. A process crash during this
narrow interval may still require operator inspection of the fully wrapped
(never plaintext) row; cross-process recovery and rotation remain future work.

The deletion-intent consumer and source-field migration remain release
blockers. In particular, this composition does not route OAuth, provider, MCP,
federation, cursor, or DXT source columns through the new client yet.

Migration 076 establishes the separate installation-ownership prerequisite.
`service_credentials`, `credential_requirements`, and `ironclaw_tools` now carry
one non-null stable `installation_id`, and their repositories join every
read/write/delete to the singleton owner. A database-side compare-and-swap reset
cascade-deletes those rows and can run while user vaults are locked. The future
installation root key and OS-wrapper deletion must be composed around this
operation before a device-reset surface is exposed.

The same migration makes `worker_dead_letter` content-free by permanently
discarding legacy `error_message` and `context` values. Runtime DLQ persistence
and the audited scheduled-job failure paths use stable job and error codes. The
source-contract test covers the worker entrypoint, discovered job modules,
current direct sinks, and representative indirections as defense-in-depth; it is
not semantic proof over arbitrary JavaScript wrappers.
Replay is cadence-driven and re-reads live state, so no user-owned payload table
is needed.

This encryption-only branch does not include the separate reasoning-mode and
inference-receipt migrations numbered 072, 074, and 075. The field inventory
must be regenerated against their cumulative schema when those branches first
land together; pulling those unrelated tables into this ownership gate would
hide, rather than resolve, the integration obligation.

These ownership and redaction controls do not encrypt the remaining credential
and capability source fields. Consequently, the public privacy policy remains
unchanged: source fields are not represented as encrypted at rest. Passing
unit tests for this kernel is
design and implementation evidence only, not packaged-platform or coverage
evidence.
