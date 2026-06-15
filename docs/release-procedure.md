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
2. **`desktop-mac` / `desktop-windows` / `desktop-linux`** — `pnpm --filter skytwin-desktop run package:<os> --publish never`. `--publish never` is deliberate: these jobs only *build + validate* packageability and upload the artifacts; they do not publish (see the comments in `build.yml`).
3. **`mobile-android` / `mobile-ios`** — Android `.apk` + an unsigned iOS simulator `.app` zip.
4. **`release`** (`needs:` all five build jobs) — downloads every artifact and runs `softprops/action-gh-release@v3` with **`draft: true`** + `generate_release_notes: true`, attaching: `.dmg`, `.zip` (mac), `.exe` (Windows NSIS), `.AppImage` / `.deb` / `.rpm` (Linux), `.apk` (Android), and the iOS simulator zip.

The release is created as a **draft**. Nothing is public until a human opens the draft in GitHub Releases and clicks **Publish**.

---

## Pre-flight before the FIRST public release

Two known gaps (both tracked; see the launch-readiness report). Until they close, a tag-push still produces a *usable but unsigned* draft release with no auto-update.

### 1. Code signing is NOT wired (#368 / #359)

The desktop package jobs set `CSC_IDENTITY_AUTO_DISCOVERY: 'false'` and skip signing for CI. Acquiring the Apple Developer + Windows EV certs is necessary but **not sufficient** — after the certs exist you must also wire the secrets into the three `package:*` steps in `build.yml`:

- macOS notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, plus `CSC_LINK` + `CSC_KEY_PASSWORD`, and flip `CSC_IDENTITY_AUTO_DISCOVERY` on.
- Windows: `CSC_LINK` + `CSC_KEY_PASSWORD` (the EV cert).

Until then, macOS Gatekeeper / Windows SmartScreen warn on first launch (the README documents the right-click→Open / More-info→Run-anyway bypass).

### 2. Auto-update manifests are NOT generated (#370)

`electron-updater` is wired client-side (`apps/desktop/src/auto-update.ts`), but the `release` job uploads only installer artifacts — not the `latest-mac.yml` / `latest.yml` / `latest-linux.yml` manifests electron-updater polls. Until the package/release steps emit + attach those manifests, installed apps cannot discover updates. Generating them is the remaining code half of #370.

### 3. Google OAuth verification (#351)

Independent of the build: until Google's restricted-scope review clears, the bundled OAuth consent screen shows the unverified-app warning. Does not block cutting a build; does affect the Gmail connect experience. Tracked separately.

---

## Version bumps

`VERSION` is the four-part scheme (e.g. `0.6.58.0`). Bump it **in a PR** (not directly on main) before tagging. The tag must match `v$(cat VERSION)`. CHANGELOG `[Unreleased]` entries roll into a dated `## [X.Y.Z.W]` section as part of (or just before) the release PR.

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
