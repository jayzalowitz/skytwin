# Transferring capabilities between machines via DXT

Issue [#184](https://github.com/jayzalowitz/skytwin/issues/184) deferred live federation between SkyTwin instances to v1.1. For v1, the supported way to move a capability configuration from one machine to another is to **export a DXT artifact, copy the file, and import it on the target machine**.

This document describes the user flow. The export/import operations themselves land in [#180 (Desktop integration)](https://github.com/jayzalowitz/skytwin/issues/180); this document is forward-looking and will be linked from the desktop UI once those features ship.

## What's in a DXT

A DXT (Desktop eXtension Transfer) artifact is a single `.dxt` file containing:

- **Capability configuration** — the MCP server's registry id, transport (stdio command + args, or HTTP/SSE URL), declared skills, autonomy overrides, and per-app spend caps.
- **Versioned prompts** — the `@skytwin/policy-prompts` overrides specific to this capability (if any).
- **Recipe references** — if the capability was installed via a recipe, the recipe slug (so the recipe steps can be replayed on the target machine).
- **Provenance metadata** — capability_provenance_nodes attached to this server (install lineage, suggestion source).

A DXT artifact is stored in the `dxt_exports` table (schema: `packages/db/src/migrations/027-capability-acquisition.sql`) keyed by `(user_id, server_id, exported_at)` with a SHA-256 hash for integrity verification on import.

## What is NOT in a DXT

- **OAuth tokens.** The user must reconnect each integration on the new machine. This is intentional: tokens are tied to the device fingerprint and may be revoked when re-installed elsewhere.
- **Twin profile / preferences.** Capability transfer is scope-limited to one MCP server's config — not the whole twin. The full twin profile is available via the existing `/export` endpoint as JSON or Markdown.
- **Memory palace contents.** Episodic memory and the knowledge graph remain on the source machine.
- **Decision history.** Each instance keeps its own local history.

## Export flow

The export will be implemented in [#180](https://github.com/jayzalowitz/skytwin/issues/180); this is the planned shape.

1. From the source machine, navigate to **Capabilities → [server] → Settings → Export DXT**.
2. SkyTwin writes a row to `dxt_exports` with the serialised configuration and SHA-256 hash, then offers the artifact as a file download.
3. Copy the `.dxt` file to the target machine via your preferred mechanism (USB drive, AirDrop, encrypted cloud storage). The file contains no plaintext secrets — only configuration metadata — but treat it like any other settings export.

## Import flow

1. On the target machine, navigate to **Capabilities → Import DXT** and select the `.dxt` file.
2. SkyTwin verifies the SHA-256 hash, parses the configuration, and shows a preview of what will be installed (which MCP server, which skills, which spend caps, which prompts).
3. After explicit user confirmation, the capability is installed via the same code path as a fresh install (`McpHost.installServer`) and a `capability_provenance_nodes` row is written with `node_type = 'manual_install'` and `payload.source = 'dxt_import'` for audit trail.
4. The user is prompted to reconnect any OAuth integrations the capability needs.

## Privacy considerations

- DXT artifacts contain capability configuration metadata only. No conversation history, memory contents, or OAuth tokens.
- The artifact's SHA-256 hash is recorded in `dxt_exports.artifact_sha256` so you can detect tampering between export and import.
- Anyone with the file can install the same capability on their own SkyTwin and connect their own credentials. They cannot impersonate you or read your data.
- If you exported a DXT and later regret it, revoke any OAuth tokens that were linked to the source instance (each integration provider — Gmail, Calendar, etc. — has its own revoke flow); the DXT itself contains no tokens to revoke.

## Limitations

- **No live federation.** Each SkyTwin instance is independent. DXT transfer is a one-shot snapshot, not a sync. Changes made on one instance after export do not propagate.
- **OAuth re-auth required.** Every integration must be re-authorised on the target machine.
- **Versioning.** The target SkyTwin must be on a compatible schema (currently: same major version). Imports across major versions are rejected with a clear error.

## When to use it

- Migrating from one personal machine to another (e.g. new laptop).
- Sharing a curated capability bundle with a teammate (your config, their tokens).
- Backing up a hand-tuned capability configuration outside the live database.

For any of these, DXT is the v1 mechanism. Live federation will follow once the privacy story for sync (which devices, which memory subsets, which caps each device) is properly designed in v1.1.

## See also

- [#180](https://github.com/jayzalowitz/skytwin/issues/180) — Desktop integration (DXT export/import implementation)
- [#184](https://github.com/jayzalowitz/skytwin/issues/184) — Provenance graph + multi-modal evidence (this document is one of its acceptance criteria)
- `packages/db/src/migrations/027-capability-acquisition.sql` — `dxt_exports` table schema
