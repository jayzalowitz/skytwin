# Source-key broker implementation status

This change establishes part of the general source-field encryption
architecture. It does **not** enable a broad at-rest encryption claim and does
not migrate a production field through this broker. A separate, older
API-local OAuth vault can encrypt new/reconnected token secrets when its
matching generation is unlocked and can migrate complete plaintext grants on
authorized use; that narrow path does not use this broker or reach the worker.

The implemented kernel provides a random per-user root, a versioned mandatory
passphrase recovery wrapper, explicit scrypt parameters, purpose-separated
HKDF data keys, context-bound AES-256-GCM envelopes, strict envelope parsing,
per-child capabilities, role/field/owner authorization, and a one-hour lock
key-cache TTL plus a lock barrier with bounded child acknowledgements. The API
and worker now construct fixed-role, fail-closed clients on their private child
IPC channels. Those clients strictly bind each response to its request,
generation, operation, context, and API session grant; bound pending work and timeouts; treat
disconnect as terminal; and defer an owner lock acknowledgement until admitted
owner-scoped callbacks drain. Electron main validates the same versioned wire
contract before authorizing any request. Every child binding still starts with
empty owner authority. A real API session can receive an opaque,
session-bound grant only after the API and Electron each revalidate its exact
session ID, owner, token hash, revocation state, and expiry against CockroachDB;
Electron repeats that check for every cryptographic request. Revocation,
expiry, child restart, malformed authority traffic, or a lock race removes or
closes that authority. Demo, development-bypass, service, unauthenticated, and
worker paths cannot mint a grant. The renderer-facing source-vault preload
surface and handlers are deliberately unavailable: loopback-port identity is
not an ownership proof.

Session-token hashes are globally unique under migration 082. The migration
refuses ambiguous existing rows instead of choosing an owner and verifies that
an `IF NOT EXISTS` namesake is actually the expected global unique index. API
authentication, last-active maintenance, and conditional expiry refresh happen
in one CockroachDB statement and use its returned canonical expiry. Concurrent
exact grant requests share the first admission. Only an independently
revalidated, strictly later expiry for the same session, owner, and token can
rotate it; substitutions and non-increasing leases cannot replace it. Electron
treats a definitive inactive result as revocation and a newer canonical expiry
as supersession without a tombstone, while a
transient database failure denies only that operation and preserves the grant
for a later independently revalidated retry.

Migration 073 defines the CockroachDB recovery-key registry and durable device
wrapper deletion intent. The broker also supports explicit device opt-in, but
only when Electron reports an exact reviewed OS protection backend; stored
wrappers bind that backend, and corrupt, legacy, or backend-mismatched wrappers
are purged while the mandatory recovery wrapper is retained. The desktop
now composes its injected `WrappedKeyStore` through the narrow
`@skytwin/db/source-key-registry` subpath. Packaged builds resolve that leaf
from the already-contained API deployment rather than shipping the DB package's
unrelated runtime graph twice; build-time and runtime checks fail closed if the
exact leaf is absent or escapes that deployment. Recovery wrappers are stored
in CockroachDB; the legacy Electron recovery-wrapper file is neither read nor
deleted, and database or module failure has no fallback. Device wrappers remain
local. API child bindings start empty and admit only the exact live human
session authority described above; worker bindings remain empty. No repository
consumes either child client, so all production source fields remain on their
existing storage paths. An owned-service identity proof, deletion-intent
consumer, production source repository clients and source-specific migration
remain release blockers.

There is not yet a linearizable owner-wide broker barrier around database-only
session cascades or `sessionRepository.revokeAllForUser`. Per-operation database
revalidation prevents use after the database mutation commits, but it does not
atomically tombstone every in-memory session grant at that commit boundary.
No source consumer may be activated until account purge and every bulk-revoke
entry point coordinate such a barrier (or an equivalent durable generation).

Migration 081 separately closes the broker plan's global dead-letter ownership
prerequisite. `worker_dead_letter` now stores only constrained job/error codes,
bounded attempts, status/timestamps, and opaque UUID identifiers. The migration
discards existing diagnostic strings and JSON by removing those columns;
CockroachDB reclaims the dropped physical data asynchronously under its configured
GC policy, while prior backups retain their normal lifecycle. The worker and admin
API have no content-bearing DLQ fields. This is a content-removal boundary, not
evidence that the broker is active for any user-owned source field.

Consequently, the public privacy policy cannot make a general source-field
encryption-at-rest claim. It separately discloses the API-local OAuth vault's
mixed storage and cross-process limit. Passing unit tests for this kernel is
design and implementation evidence only, not packaged-platform or coverage
evidence.
