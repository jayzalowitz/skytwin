# Source-key broker implementation status

This change establishes part of the source-field encryption architecture. It
does **not** enable an at-rest encryption claim and does not migrate any
production source field.

The implemented kernel provides a random per-user root, a versioned mandatory
passphrase recovery wrapper, explicit scrypt parameters, purpose-separated
HKDF data keys, context-bound AES-256-GCM envelopes, strict envelope parsing,
per-child capabilities, role/field/owner authorization, and a one-hour lock
barrier with bounded child acknowledgements. The source-vault preload surface
and IPC handlers are deliberately unavailable: loopback-port identity is not
an ownership proof. Electron binds the broker only to API and worker processes
it started and gives each child a random, process-scoped capability.

Migration 073 defines the CockroachDB recovery-key registry and durable device
wrapper deletion intent. The broker also supports explicit device opt-in, but
only when Electron reports an exact reviewed OS protection backend; stored
wrappers bind that backend, and corrupt, legacy, or backend-mismatched wrappers
are purged while the mandatory recovery wrapper is retained. Production desktop
composition stores the recovery wrapper in the CockroachDB registry. The API
requests an owner grant only after validating that user's session, and the
parent independently enforces the session deadline on every broker request.
The worker replaces its complete owner set after database-backed connector
discovery, so owners absent from the new set lose authority atomically. A
transient discovery failure is not an empty snapshot and preserves the last
authoritative set; connector startup success does not define key ownership.

API grants retain the exact session nonce and database-proven expiry rather than
collapsing multiple sessions into one owner deadline. Revoking or expiring one
session preserves any independently valid session, but every API secret request
also carries its originating nonce and the parent requires that exact grant to
remain live; a paused request cannot borrow a second session's authority.
Worker requests use a separate service-authenticated request shape and complete
database owner snapshot. Account deletion commits a
content-free cleanup intent in the same transaction as the database purge. The
parent then fences that owner across API and worker children, drains in-flight
work, drops the in-memory key, deletes the optional device wrapper and remembered
vault passphrase, and marks the intent complete. Pending intents are replayed
before an external API is accepted or a replacement API child is started and
given a capability. An unreadable ledger revokes all existing child capabilities
and locks all cached roots before startup retries. Periodic desktop reconciliation
also completes cleanup initiated through an external development API. A
brokerless API truthfully returns `cleanupPending` because capability absence
cannot prove that native secrets are absent.

Lock and unlock close admission, request a capability-authenticated child
acknowledgement, and wait for in-flight calls. A child that does not acknowledge
is terminated; key availability changes only after the parent observes its
actual exit or close event. If termination cannot be proven, the revoked child
binding is retained and the operation fails closed for a later retry. Unlock
then broadcasts the new generation to granted children.

Registry initialization creates only the first wrapper for an owner, validates
it by exact read-back and canary decryption, and binds cleanup to the complete
wrapper value created by that attempt. A conflicting or replacement row cannot
be deleted by rollback.

Consequently, the public privacy policy remains unchanged: source fields are
not represented as encrypted at rest. Passing unit tests for this kernel is
design and implementation evidence only, not packaged-platform or coverage
evidence. Source-field migration remains a release blocker; OAuth, provider,
MCP, federation, cursor, and DXT source columns do not yet route through this
client.
