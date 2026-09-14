# Packaged sample release evidence

The canonical verifier for `sample.packaged-account-free` is
[`scripts/release-claims/verifiers/sample.packaged-account-free.mjs`](../scripts/release-claims/verifiers/sample.packaged-account-free.mjs).
It runs only inside the native machine-evidence matrix in
[`build.yml`](../.github/workflows/build.yml), after all release artifacts from
the same tag-push run have been downloaded.

The workflow invokes the same reviewed source in two separate steps. The first
step alone receives the GitHub token and writes a nonsecret descriptor:

```bash
node scripts/release-claims/verifiers/sample.packaged-account-free.mjs \
  --discover \
  --platform macos \
  --descriptor .release-evidence/provenance/sample.packaged-account-free.macos.json
```

After that credentialed process and its shell have exited, the second step has
no `GITHUB_TOKEN` or `GH_TOKEN` and performs all parsing, extraction, execution,
and probing. A nonsecret SHA-256 passed through the workflow output channel
binds the descriptor bytes between the two steps:

```bash
node scripts/release-claims/verifiers/sample.packaged-account-free.mjs \
  --verify \
  --platform macos \
  --descriptor .release-evidence/provenance/sample.packaged-account-free.macos.json \
  --output .release-evidence/reports/sample.packaged-account-free.macos.json
```

`windows` and `linux` use the corresponding platform-named report. The verifier
rejects ad-hoc provenance arguments. Discovery obtains the repository, tag,
source SHA, run, and token from the Actions context and independently queries
the GitHub Actions API for the current run and artifact. Verification rechecks
the nonsecret context and downloaded subject against the descriptor:

| Native runner | Canonical downloaded artifact | Subject kind | Derivation |
|---|---|---|---|
| macOS | `artifacts/SkyTwin-macOS-zip/<one .zip>` | desktop archive | `zip-ditto` |
| Windows | `artifacts/SkyTwin-Windows-installer/<one .exe>` | desktop installer | `nsis-7zip` |
| Linux | `artifacts/SkyTwin-Linux-AppImage/<one .AppImage>` | desktop installer | `appimage-extract` |

The downloaded artifact directory must contain exactly one direct regular file.
Archive inventories reject absolute or escaping paths, duplicates,
case-collisions, unsafe Windows names, and special files; extracted symlinks
must remain within the private extraction root. The verifier requires one
platform-specific executable and records its digest and stable pre/post file
identity separately from the uploaded container subject. It also revalidates
the container after the run. Linux derives the SquashFS payload with the
runner's trusted 7-Zip rather than executing the AppImage's extraction mode.

Credentialed GitHub artifact discovery runs in its own workflow step and exits
after writing the provenance descriptor. A later workflow step rejects
`GITHUB_TOKEN` and `GH_TOKEN` in the verifier environment, validates the
descriptor and its workflow-carried digest, and launches the executable. The
packaged child receives a strict allowlisted environment with no GitHub, cloud,
proxy, or database credentials. It starts on an unused loopback port with a
fresh temporary OS and Electron profile, production authentication settings,
and a random process attribution nonce. A report is written with exclusive
creation only after the live process tree accepts the first platform-native
termination request and ports 3100 and 3200 are released. POSIX runners require
the process group to disappear after `SIGTERM`; Windows uses the tree-aware
`taskkill /T /F` primitive because it has no process-group `SIGTERM`. A second
termination request, POSIX `SIGKILL`, or a still-live process group fails the
evidence run.

The live packaged probe verifies:

- the dashboard shell, sample API, session, populated decision, and explanation
  are all available within one 60-second launch deadline;
- the packaged Electron renderer activates the real first-run sample control,
  reaches `#/sample`, and renders the four fictional proposal cards; its proof
  file is confined to the fresh profile and bound to a renderer-only verifier
  nonce that API, web, and worker children do not inherit;
- nonce-bound sample readiness and non-cacheable responses;
- unauthenticated denial with the development bypass disabled;
- two distinct credentials with the advertised four-hour lifetime;
- a populated sample decision and its explanation;
- the fixed, approval-gated simulation catalog;
- approve, reject, and correction results, while recording that
  `simulationOnly` and `externalEffects` are API-returned markers;
- correction retention within one credential and isolation from another;
- denial of tampered credentials, a foreign user selector, settings,
  credentials, search, capability installation, approval execution, inference,
  mutation, and SSE entrances; and
- reset, disposal, replay denial, and cleanup of both sessions.

The report binds the canonical producer job, verifier path, exact command,
verifier SHA-256, current-run artifact ID and digest, downloaded subject path and
digest, native platform, derived executable, and a structured passing
observation. The exclusive repository aggregator collects all machine reports;
there is no sample-specific aggregator or alternate uploader.

Passing source tests or landing this verifier does **not** certify a published
artifact. The claim remains limited and release remains blocked until one
immutable tagged run produces passing macOS, Windows, and Linux reports and the
publisher revalidates them. This report also does not prove signing,
notarization, minimum hardware, network-egress capture, hostile-database
provisioning, service-generation authority, or tray pause/recovery behavior.
Those are separate release claims or lifecycle checks in
[`release-procedure.md`](./release-procedure.md).
