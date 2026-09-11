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
wrapper deletion intent. The broker also supports explicit device opt-in, but
only when Electron reports genuine OS protection; corrupt wrappers are removed
and the mandatory recovery wrapper is retained. The desktop adapter in this
initial patch is still an injected `WrappedKeyStore`; production composition
must replace the temporary Electron-store adapter with the Cockroach-backed
repository before any source field is encrypted. The API and worker child
bindings currently have empty owner grants and therefore fail closed. Their
authenticated owner-grant client, deletion-intent consumer, and production
repository gateway remain release blockers.

Consequently, the public privacy policy remains unchanged: source fields are
not represented as encrypted at rest. Passing unit tests for this kernel is
design and implementation evidence only, not packaged-platform or coverage
evidence.
