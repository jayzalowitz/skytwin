# Release Procedure

How to cut a public SkyTwin release. This is the **current, accurate** flow as of 2026-06-14 — the old `.github/workflows/release.yml` was deleted in #356; **`.github/workflows/build.yml` is now the only publisher** (its `release` job). Source of truth: `.github/workflows/build.yml` (the `release:` job, `if: startsWith(github.ref, 'refs/tags/v')`).

Pairs with [`launch-plan.md`](./launch-plan.md) (what blocks the *first* public launch) and [`launch-readiness-report.md`](./launch-readiness-report.md) (current blocker status).

---

## TL;DR

```bash
# from an up-to-date main
git checkout main && git pull
# VERSION already holds the version you're releasing (bump it in a PR first if not)
git tag -a "v$(cat VERSION)" -m "Release v$(cat VERSION)"
git push origin "v$(cat VERSION)"
# build.yml builds all platforms, then its `release` job creates a DRAFT GitHub Release.
# Review the draft, then publish it manually.
```

That's the mechanical flow. Read the rest before the **first** public release — there are two gaps (signing, auto-update manifests) you must close first, or accept.

---

## What happens on a `v*` tag push

`build.yml` triggers on `push: tags: ['v*']`. The relevant jobs:

1. **`test`** + **`changes`** — gate the build (the desktop/mobile jobs `needs: [test, changes]`). The eval suite is a **separate** workflow (`.github/workflows/evals.yml`) and does **not** run on `v*` tag pushes, so don't assume evals ran as part of cutting a release.
2. **`desktop-mac` / `desktop-windows` / `desktop-linux`** — each job first runs `.github/scripts/derive-app-version.sh` (exports `APP_VERSION`; see [Version bumps](#version-bumps)), then `pnpm --filter skytwin-desktop run package:<os> --publish never "--config.extraMetadata.version=${APP_VERSION}"`. `--publish never` is deliberate: these jobs only *build + validate* packageability and upload the artifacts; they do not publish (see the comments in `build.yml`). `--config.extraMetadata.version` is what stamps the real version onto the artifacts and the `latest*.yml` manifests.
3. **`mobile-android` / `mobile-ios`** — Android `.apk` + an unsigned iOS simulator `.app` zip.
4. **`release`** (`needs:` all five build jobs) — first verifies the GitHub Releases endpoint is reachable (`curl -f https://github.com/<repo>/releases/latest`, fails the job on non-2xx — #370 AC#2), then downloads every artifact and runs `softprops/action-gh-release@v3` with **`draft: true`** + `generate_release_notes: true`, attaching: `.dmg`, `.zip` (mac), `.exe` (Windows NSIS), `.AppImage` / `.deb` / `.rpm` (Linux), `.apk` (Android), the iOS simulator zip, **and the electron-updater manifests `latest-mac.yml` / `latest.yml` / `latest-linux.yml`** (#370).

The release is created as a **draft**. Nothing is public until a human opens the draft in GitHub Releases and clicks **Publish**.

---

## Pre-flight before the FIRST public release

Two known gaps (both tracked; see the launch-readiness report). Until they close, a tag-push still produces a *usable but unsigned* draft release with no auto-update.

### 1. Code signing is NOT wired (#368 / #359)

The desktop package jobs set `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and skip signing for CI. Acquiring the Apple Developer + Windows EV certs is necessary but **not sufficient** — after the certs exist you must also wire the secrets into the three `package:*` steps in `build.yml`:

- macOS notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus `CSC_LINK` + `CSC_KEY_PASSWORD`, and flip `CSC_IDENTITY_AUTO_DISCOVERY` on.
- Windows: `CSC_LINK` + `CSC_KEY_PASSWORD` (the EV cert).

Until then, macOS Gatekeeper / Windows SmartScreen warn on first launch (the README documents the right-click→Open / More-info→Run-anyway bypass).

### 2. Auto-update manifests now ship — but the path is live only after signing (#370)

`electron-updater` is wired client-side (`apps/desktop/src/auto-update.ts`), and the `release` job **now attaches the `latest-mac.yml` / `latest.yml` / `latest-linux.yml` manifests** electron-updater polls (the remaining code half of #370 — electron-builder generates them under `--publish never`, and the three desktop jobs collect them as artifacts). So an installed app *can* discover the next version. The **user-facing update surface now exists too**: `AutoUpdateController.start()` subscribes to electron-updater's lifecycle events and the dashboard shows a bottom banner (downloading → "Update ready to install" with a Restart-to-update button), plus a "Check for Updates…" menu item for an on-demand poll. A second, separately-fatal half of this is also fixed: the manifests used to be stamped with the frozen `0.3.0` placeholder, so *discovery* could never succeed no matter what was attached. CI now injects a derived version (see [How the desktop app version is derived](#how-the-desktop-app-version-is-derived)).

The remaining catch: electron-updater verifies the downloaded update's signature and **refuses an unsigned payload** (fails safe). Until code signing lands (gap 1 / #368 / #359), the banner surfaces "downloading" but the install step can't complete on an unsigned build. The manifests shipping early is harmless — verify with `gh release view <tag> --json assets` that all three `latest*.yml` are attached, and that the asset filenames carry the derived version (e.g. `SkyTwin-0.6.10100-arm64.dmg`), not `0.3.0`.

### 3. Google OAuth verification (#351)

Independent of the build: until Google's restricted-scope review clears, the bundled OAuth consent screen shows the unverified-app warning. Does not block cutting a build; does affect the Gmail connect experience. Tracked separately.

---

## Version bumps

`VERSION` is the four-part scheme (e.g. `0.6.58.0`). Bump it **in a PR** (not directly on main) before tagging. The tag must match `v$(cat VERSION)`. CHANGELOG `[Unreleased]` entries roll into a dated `## [X.Y.Z.W]` section as part of (or just before) the release PR.

### How the desktop app version is derived

electron-builder **rejects** a four-segment version, so `apps/desktop/package.json` cannot simply mirror `VERSION`. It carries a fixed placeholder (`0.3.0`) that exists only so local `pnpm --filter skytwin-desktop package:mac` works with no setup — **do not** hand-bump it. From #31 until this was fixed, that placeholder was also what shipped: electron-builder stamps artifact filenames *and* the `latest*.yml` update manifests from it, so every release published `0.3.0`, and electron-updater's semver compare against an installed `0.3.0` answered "no update available" forever. Auto-update could never fire.

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

## Verifying a published release

After publishing the draft:

```bash
# the download links the README points at must resolve
curl -fsSLI https://github.com/jayzalowitz/skytwin/releases/latest >/dev/null && echo "latest release reachable"
```

Then a clean-machine smoke test: download the `.dmg` / `.exe` on a box that has never seen SkyTwin, install, and confirm it reaches a populated dashboard (sample-profile path) within 60s. Once signing + auto-update manifests land (gaps 1 + 2), also verify the unsigned-warning is gone and that installing release N then tagging N+1 self-updates within the ~6-hour poll window (the `auto-update.ts` `DEFAULT_CHECK_INTERVAL_MS` default).

---

## Rollback

A bad release is rolled back by deleting/unpublishing the GitHub Release and the tag; no users are affected until a release is **published** (drafts are private). If a published release regressed, cut the next patch tag with the fix — electron-updater (once manifests ship) will pull users forward.
