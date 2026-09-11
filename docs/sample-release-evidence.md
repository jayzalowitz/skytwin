# Packaged sample release evidence

The canonical verifier for `sample.packaged-account-free` is
[`scripts/release-claims/verifiers/sample.packaged-account-free.mjs`](../scripts/release-claims/verifiers/sample.packaged-account-free.mjs).
It runs only inside the native machine-evidence matrix in
[`build.yml`](../.github/workflows/build.yml), after all release artifacts from
the same tag-push run have been downloaded.

The workflow invokes it with exactly two arguments:

```bash
node scripts/release-claims/verifiers/sample.packaged-account-free.mjs \
  --platform macos \
  --output .release-evidence/reports/sample.packaged-account-free.macos.json
```

`windows` and `linux` use the corresponding platform-named report. The verifier
rejects ad-hoc provenance arguments. It obtains the repository, tag, source SHA,
run, and token from the immutable Actions context and independently queries the
GitHub Actions API for the current run and artifact:

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

The executable starts on an unused loopback port with a fresh temporary OS and
Electron profile, production authentication settings, and a random process
attribution nonce. The child environment does not inherit GitHub credentials,
cloud credentials, proxy settings, or database configuration. A report is
written with exclusive creation only after the process exits cleanly and port
3100 is released.

The live HTTP probe verifies:

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
