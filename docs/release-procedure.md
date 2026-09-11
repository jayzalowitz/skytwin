# Release Procedure

> **Beta truth gate:** [`beta-claim-ledger.json`](./beta-claim-ledger.json) is
> the release-claim source of truth for `v0.7.0-beta`. Run `pnpm claims:check`
> before cutting any candidate. Every release-producing `v*` tag additionally
> runs a two-stage gate in CI. The preflight requires an exact ledger/tag/SHA
> match, ready status, and synchronized versions before packaging. After
> packaging, the release job requires a generated evidence manifest bound to
> that same repository, tag, and SHA. It verifies required CI runs, jobs, and
> artifact digests through the GitHub API, plus digest-bound machine reports and
> artifact-verification material downloaded with the evidence artifact. The raw
> reports, checksum inventory, SPDX SBOM, verification guide, and
> cryptographically verified provenance bundles are also published as exact,
> digest-verified release assets so the proof remains auditable after Actions
> artifact retention expires. The job then rejects any
> existing draft or public release for the tag, creates an unpublished draft,
> verifies that draft by its numeric release ID, exact asset names, and GitHub
> SHA-256 digests, and publishes it immediately from the same gated job. Evidence IDs
> are deliberately not committed to this ledger: doing so would change the SHA
> they attest and create an impossible hash cycle. The release job now generates
> the external manifest from current-run GitHub API metadata. Downstream
> evidence-matrix jobs now include the canonical three-platform
> packaged-sample verifier with GitHub API discovery separated from package
> execution and a strict allowlisted child environment, but
> the other seven machine-verifier implementations and the CI result producer
> are still absent. The final gate therefore fails closed and the ledger remains
> blocked until the complete proof pipeline ships.

The intended post-build contract is explicit: the tagged `build.yml` run
must produce `release-claims-ci` and `release-evidence` artifacts. The former
requires a dedicated CI-result producer; it is not currently emitted by the
`release-claim-ci` job. The latter
contains the canonical `reports/<claim-id>[.<platform>].json` results for every required machine claim
and an `artifact-verification/` directory containing the exact `SHA256SUMS`,
`release.spdx.json`, `VERIFY.md`, and digest-named provenance bundles.
The CI artifact contains `result.json`, bound to the current run, source commit,
and tag ref; the final checker hashes and validates that downloaded file as well
as its GitHub artifact metadata.
Each report is created only after its subject release artifact is uploaded, so
it can record the upload action's immutable artifact ID, name, digest, platform,
artifact kind, subject filename, and subject SHA-256. Reports use schema version
1, identify `release-machine-verifier` as their generator, bind the canonical
successful claim/platform job and reviewed verifier path/command/source digest,
and contain the exact uniquely named passing checks with structured assertion,
measurement, and exit-code observations. A later aggregation step
uploads those reports as the separate `release-evidence` artifact. After
downloading artifacts, the final job runs
`scripts/release-claims/generate-evidence-manifest.mjs`, which queries the
current run's jobs and artifacts through GitHub's API and writes
`.release-evidence/manifest.json`. The manifest is not placed inside the
artifact whose digest it records, so there is no self-referential hash. The
checker then binds the current run to the tag-push ref and release commit,
verifies both the evidence artifact and each subject release artifact through
GitHub's API, hashes each local report, downloaded subject, and verification
sidecar, and rejects unexpected claim/kind entries. It requires the checksum
and SPDX inventories to cover every canonical subject. The SBOM must satisfy
the required SPDX 2.3 document, creation, package, file, identifier, timestamp,
checksum, relationship-vocabulary, and package-verification-code contract before
subject coverage counts. `VERIFY.md` must equal a
generated canonical guide containing working checksum commands and one exact
`gh attestation verify` command per subject, bound to the repository, digest
bundle, `build.yml` signer workflow, tag ref, source SHA, and SLSA provenance
predicate. The checker then executes the same cryptographic verification for
each subject. This lets proof be generated after packaging without changing
the source SHA it attests.
One CI result and twelve machine reports — thirteen durable report files total —
plus the checksum inventory, SPDX SBOM, verification guide, provenance bundles,
and generated manifest are attached to the GitHub Release. Wildcards are used
only for the manifest-validated verification directory and package outputs; the
controlled publisher rejects missing, extra, duplicate, or digest-changed assets.

Quantified claims carry additional applicability evidence. The three native
signing reports must collectively enumerate every installer and desktop archive
subject in the release asset inventory. Each report covers only its platform and
records every subject digest and passing OS signature result; the macOS report
also requires a passing notarization result. The verified-model report must enumerate
the recommended model artifact with its source, disclosed license, published
SHA-256, passing digest verification, and passing deletion check. Omitting one
of these subjects fails the final gate.

How to cut a public SkyTwin release. This is the **current, accurate** flow as of 2026-09-14 — the old `.github/workflows/release.yml` was deleted in #356; **`.github/workflows/build.yml` is now the only publisher** (its `release` job). Source of truth: `.github/workflows/build.yml` (the `release:` job, `if: startsWith(github.ref, 'refs/tags/v')`).

Pairs with [`launch-plan.md`](./launch-plan.md) (what blocks the _first_ public launch) and [`launch-readiness-report.md`](./launch-readiness-report.md) (current blocker status).

---

## TL;DR

```bash
# from an up-to-date main
git checkout main && git pull
# VERSION/package metadata normalize to the ledger target (bump in a PR first)
RELEASE_TAG="$(node -p 'require("./docs/beta-claim-ledger.json").release.targetVersion')"
git tag -a "$RELEASE_TAG" -m "Release $RELEASE_TAG"
git push origin "$RELEASE_TAG"
# build.yml builds, verifies an unpublished draft, and publishes it automatically.
```

That's the mechanical flow. Read the rest before the **first** public release.
Every open stop-ship condition in the claim ledger must be closed with its
required evidence; none may be accepted as an informal exception. Signing and
clean-artifact verification remain release gates, while OAuth verification is
a separate onboarding constraint.

---

## What happens on a `v*` tag push

`build.yml` triggers on `push: tags: ['v*']`. The relevant jobs:

1. **`test`** + **`changes`** — gate the build (the desktop/mobile jobs `needs: [test, changes]`). The eval suite is a **separate** workflow (`.github/workflows/evals.yml`) and does **not** run on `v*` tag pushes, so don't assume evals ran as part of cutting a release.
2. **`desktop-mac` / `desktop-windows` / `desktop-linux`** — each job first runs `.github/scripts/derive-app-version.sh` (exports `APP_VERSION`; see [Version bumps](#version-bumps)), then `pnpm --filter skytwin-desktop run package:<os> --publish never "--config.extraMetadata.version=${APP_VERSION}"`. `--publish never` is deliberate: these jobs only *build + validate* packageability and upload the artifacts; they do not publish (see the comments in `build.yml`). `--config.extraMetadata.version` is what stamps the real version onto the artifacts and the `latest*.yml` manifests.
3. **`mobile-android` / `mobile-ios`** — Android `.apk` + an unsigned iOS simulator `.app` zip.
4. **`release`** (`needs:` `test`, the three desktop jobs, and the verified evidence aggregator) — verifies the evidence contract, creates an unpublished prerelease draft containing only the canonical desktop artifacts, update manifests, one CI result plus twelve machine reports (thirteen durable report files total), checksum/SBOM/instruction/provenance sidecars, and the evidence manifest, then runs `publish-verified-draft.mjs`. That script consumes the creator action's numeric release ID, requires the exact expected asset-name/digest set, independently dereferences the release tag to the triggering commit, and proves that commit is an ancestor of the current `main` branch before it changes the draft to public.

Do not publish drafts manually. If exact verification fails, the draft remains private for diagnosis; delete it before retrying the tag workflow.

The repository's `release-publication` GitHub Environment is part of this
boundary. **As of 2026-09-14 it is not configured.** Before any release, create
it with at least one required reviewer, prevent self-review, disable
administrator bypass, and add a custom tag policy matching the release tag.
The workflow verifies those live settings and fails before release
mutation if GitHub auto-creates an unprotected environment or its configuration
drifts. The release job has only `contents: write`, `actions: read`, and
`attestations: read`, serializes
publication per tag without cancellation, and scans the authenticated release
inventory immediately before draft creation so the upload action cannot reuse a
draft or mutate an existing public release. It re-fetches by release ID and
revalidates the published metadata, tag target, and complete digest set. If
publication or confirmation is ambiguous, it never repeats the publish request:
it reconciles by ID and uses only the idempotent transition back to draft.
This is fail-safe detection and recovery, not an atomic GitHub transaction:
credentials outside this protected workflow could still race the bounded interval
between the absence check, draft creation, and confirmation. Repository access
controls and exclusive release-publisher permissions remain part of the boundary.

The current workflow intentionally has no provenance producer and grants no
non-publisher job attestation-write or OIDC permission. The artifact-integrity
producer must add one exact, pinned provenance job with only the required
`attestations: write` and `id-token: write` capabilities, update the workflow
allowlist, and generate the sidecars above before the ledger can move to ready.
Until that lands, the absence is a deliberate stop-ship rather than evidence
that can be waived.

The native machine-evidence matrix and exclusive aggregator are scaffolded.
The packaged-sample verifier now implements three of the twelve matrix reports;
see [`sample-release-evidence.md`](./sample-release-evidence.md). The other
seven verifier sources (nine matrix reports) and the separate
`release-claims-ci` artifact producer are absent today. Machine reports must come from the exact
successful claim/platform job and canonical verifier step, carry the reviewed
verifier path, command, and source digest, and provide structured observations;
the release job independently checks those bindings against the current GitHub
run. The SPDX producer must emit a 2.3 document namespace, explicit package
analysis state, a component inventory, and package-to-file relationships that
cover every release subject. Until those producers land, the gate remains
blocked by design.

---

## Pre-flight before the first public release

The ledger's stop-ship conditions keep the tag job from reaching draft creation until signing, update manifests, and the other required evidence are complete.

### 1. Code signing is NOT wired (#368 / #359)

The desktop package jobs set `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and skip signing for CI. Acquiring the Apple Developer + Windows EV certs is necessary but **not sufficient** — after the certs exist you must also wire the secrets into the three `package:*` steps in `build.yml`:

- macOS notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus `CSC_LINK` + `CSC_KEY_PASSWORD`, and flip `CSC_IDENTITY_AUTO_DISCOVERY` on.
- Windows: `CSC_LINK` + `CSC_KEY_PASSWORD` (the EV cert).

Until then, macOS Gatekeeper / Windows SmartScreen warn on first launch (the README documents the right-click→Open / More-info→Run-anyway bypass).

### 2. Auto-update manifests now ship — but the path is live only after signing (#370)

`electron-updater` is wired client-side (`apps/desktop/src/auto-update.ts`), and the `release` job **now attaches the `latest-mac.yml` / `latest.yml` / `latest-linux.yml` manifests** electron-updater polls (the remaining code half of #370 — electron-builder generates them under `--publish never`, and the three desktop jobs collect them as artifacts). So an installed app _can_ discover the next version. The **user-facing update surface now exists too**: `AutoUpdateController.start()` subscribes to electron-updater's lifecycle events and the dashboard shows a bottom banner (downloading → "Update ready to install" with a Restart-to-update button), plus a "Check for Updates…" menu item for an on-demand poll. A second, separately-fatal half of this is also fixed: the manifests used to be stamped with the frozen `0.3.0` placeholder, so _discovery_ could never succeed no matter what was attached. CI now injects a derived version (see [How the desktop app version is derived](#how-the-desktop-app-version-is-derived)).

The remaining catch: electron-updater verifies the downloaded update's signature and **refuses an unsigned payload** (fails safe). Until code signing lands (gap 1 / #368 / #359), the banner surfaces "downloading" but the install step can't complete on an unsigned build. The manifests shipping early is harmless — verify with `gh release view <tag> --json assets` that all three `latest*.yml` are attached, and that the asset filenames carry the derived version (e.g. `SkyTwin-0.6.10100-arm64.dmg`), not `0.3.0`.

### 3. Google OAuth verification (#351)

Independent of the build, two review tracks affect onboarding. The bundled
identity-and-Calendar client still needs brand and sensitive-scope verification;
until those clear, its consent screen can show an unverified-app warning. Gmail
scopes are dropped from that bundled flow today. Launch Gmail access instead uses
a personal BYO client, which shows its own unverified warning and requires an
In-production publishing status to avoid seven-day Testing authorization expiry.
Neither track blocks cutting a build, but both affect the connection experience.
Bundled Gmail restricted-scope verification is tracked separately in #351.

---

## Version bumps

`VERSION` is the four-part repository/package scheme (e.g. `0.7.0.0`). Bump it **in a PR** (not directly on main) before tagging. The tag must exactly equal the claim ledger's `release.targetVersion`; for this beta, `v0.7.0-beta` intentionally normalizes to repository version `0.7.0.0`. CHANGELOG `[Unreleased]` entries roll into a dated release section as part of (or just before) the release PR.

### How the desktop app version is derived

electron-builder **rejects** a four-segment version, so `apps/desktop/package.json` cannot simply mirror `VERSION`. It carries a fixed placeholder (`0.3.0`) that exists only so local `pnpm --filter skytwin-desktop package:mac` works with no setup — **do not** hand-bump it. From #31 until this was fixed, that placeholder was also what shipped: electron-builder stamps artifact filenames _and_ the `latest*.yml` update manifests from it, so every release published `0.3.0`, and electron-updater's semver compare against an installed `0.3.0` answered "no update available" forever. Auto-update could never fire.

CI now derives a real three-segment version from `VERSION` and injects it at package time:

```
major.minor.patch.build  ->  major.minor.(patch * 100 + build)

0.1.0.0    -> 0.1.0
0.3.3.1    -> 0.3.301
0.6.23.2   -> 0.6.2302
0.6.101.0  -> 0.6.10100
```

Source of truth: [`.github/scripts/derive-app-version.sh`](../.github/scripts/derive-app-version.sh), called by the `Derive app version` step in each of the three desktop jobs in [`build.yml`](../.github/workflows/build.yml).

The mapping is base-100 positional encoding of `(patch, build)`, which gives the two properties auto-update depends on:

- **Injective** — no two `VERSION`s produce the same derived version. A collision would make a real release look identical to its predecessor and clients would skip it.
- **Monotonic** — the derived version increases whenever `VERSION` increases. A decrease would look like a downgrade and electron-updater would refuse it.

Both hold only while the fourth segment stays below 100, so the script **hard-fails** if `build >= 100` (as well as on any non-four-segment or non-numeric `VERSION`) rather than silently emitting a colliding version. Every `VERSION` in this repo's history has had `build <= 2`. If you ever need more than 99 builds against one patch number, bump the patch segment instead; raising `BUILD_SCALE` in the script is possible but it must only ever grow, never shrink, or monotonicity breaks across the change.

Guards: `apps/desktop/src/__tests__/derive-app-version.test.ts` (runs the script over the full historical `VERSION` list and asserts injectivity + strict monotonicity + rejection of bad input) and `apps/desktop/src/__tests__/app-version-injection.test.ts` (asserts all three desktop package steps still pass `--config.extraMetadata.version`, so a future workflow edit can't silently re-freeze the version).

### Consequence for the extracted embedded bundle

The desktop app unpacks `<resources>/embedded/apps.tar.gz` into `<userData>/embedded/` on first launch and keys the cache off a marker file. That marker used to be `app.getVersion()` — frozen at `0.3.0` — so a user upgrading via a newer `.dmg` kept the marker match and silently ran the new Electron shell against the **stale** extracted API/worker/web backend. The marker is now the bundle's own sha256 (`bundleId` in `bundle-manifest.json`, written by `apps/desktop/scripts/build-single-binary.sh`); see `apps/desktop/src/bundle-marker.ts`. Upgrading users re-extract exactly once when the bundle actually changes.

---

## Verifying the draft before publication

Before the gated workflow can publish, its evidence producers must exercise the
candidate artifacts on clean machines and record digest-bound evidence for every
item below. The packaged-sample verifier covers the rendered sample surface and
HTTP portions of items 1 and 2 as documented in
[`sample-release-evidence.md`](./sample-release-evidence.md);
items 3–5 still require separate lifecycle evidence. A populated dashboard
alone is not sufficient:

1. The app reaches the fictional sample dashboard within 60 seconds with `SKYTWIN_DEV_AUTH_BYPASS` unset. `GET /api/v1/demo/info` reports availability before `POST /api/v1/demo/session` returns a credential fixed to the reserved sample user and a four-hour expiry.
2. That credential can read a sample decision and its explanation, but receives an authorization denial for mutations, settings, credential/configuration changes, search, connector invocation, MCP/tool execution, paid or inference-bearing endpoints, SSE, and a request for any other user. Connector status and capability provenance/metrics reads may remain available. Minting a second session returns a distinct credential; the automated demo-session tests must also prove expired and tampered credentials are rejected.
3. Provisioning succeeds only against the CockroachDB child attested to the app's canonical data directory. Repeat the first-launch attempt with an inherited or unrelated loopback `DATABASE_URL` and confirm the app refuses to initialize, migrate, seed, or route services to it.
4. The API proves authenticated readiness for its exact spawn before web or worker become ready, and the worker's durable generation authority is active only for that generation.
5. Verify normal tray pause stops the worker and suppresses delayed replacement while an exact ready API/web generation may remain available. Then pause once during startup and once during restart backoff; confirm the newer pause cancels recovery and contains any partial or failed generation. Resume must reuse the exact ready API/web generation when safe or otherwise rebuild API → durable authority → authenticated readiness → web, then start the worker. API or database authority loss must revoke and contain the generation, while an isolated web or worker crash may recover inside the still-ready API generation.

Only after those reports and every other ledger gate pass may the controlled
workflow create and publish its verified draft. After it publishes, verify the
public download target resolves:

```bash
curl -fsSLI https://github.com/jayzalowitz/skytwin/releases/latest >/dev/null && echo "latest release reachable"
```

Once `sample.packaged-account-free` has its required machine evidence, confirm
the installed candidate reaches its populated sample within the release
contract's latency target. After signing and update evidence land, verify the
unsigned warning is
gone and that installing release N then tagging N+1 self-updates within the
configured poll window (`DEFAULT_CHECK_INTERVAL_MS` in `auto-update.ts`).
Confirm all three `latest*.yml` assets point at the signed N+1 artifacts.

---

## Upgrade and rollback

A bad release is rolled back by deleting/unpublishing the GitHub Release and the tag; no users are affected until a release is **published** (drafts are private). If a published release regressed, cut the next signed patch tag with the fix — the shipped update manifests let electron-updater pull users forward.
