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
key-cache TTL plus a lock barrier with bounded child acknowledgements. Electron
main attaches the API and worker through private child-process IPC, but gives
them empty owner grants. The renderer-facing source-vault preload surface and
handlers are deliberately unavailable: loopback-port identity is not an
ownership proof. Runtime activation remains blocked on authenticated
owner-bound grants and clients for the services Electron already starts.

Migration 073 defines the CockroachDB recovery-key registry and durable device
wrapper deletion intent. The broker also supports explicit device opt-in, but
only when Electron reports an exact reviewed OS protection backend; stored
wrappers bind that backend, and corrupt, legacy, or backend-mismatched wrappers
are purged while the mandatory recovery wrapper is retained. The desktop
adapter in this initial patch is still an injected `WrappedKeyStore`;
production composition must replace the temporary Electron-store adapter before
this broker encrypts any source field. The API and worker child bindings
currently have empty owner grants and therefore fail closed. The authenticated
owner-grant client, owned-service identity proof,
child lock-ack client, deletion-intent consumer, and production repository gateway remain
release blockers.

Consequently, the public privacy policy cannot make a general source-field
encryption-at-rest claim. It separately discloses the API-local OAuth vault's
mixed storage and cross-process limit. Passing unit tests for this kernel is
design and implementation evidence only, not packaged-platform or coverage
evidence.
