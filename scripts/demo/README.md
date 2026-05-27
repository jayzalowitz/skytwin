# SkyTwin Demo Recorder (#414)

Deterministic launch-video pipeline. Renders [`docs/demo.md`](../../docs/demo.md)
into an mp4 you can hand to the Google OAuth review team without filming
anything yourself.

**Every dependency is local-first and open-source:**

| Step | Tool | Source |
|---|---|---|
| Browser drive | Playwright | npm dev-dep of this package |
| Screenshot loop | Playwright `page.screenshot()` | same |
| Narration | Piper TTS via `/api/voice/synthesize` | `@skytwin/embedded-llm` (already in the tree) |
| Video assembly | `ffmpeg` | Homebrew / your platform package manager |

No ElevenLabs key, no Selenium, no cloud anything.

## One-time setup

```sh
# Install local deps.
# `--ignore-workspace` is required because scripts/demo/ is a standalone
# tool — not a workspace package — so the recorder's Playwright dep
# doesn't pollute the rest of the monorepo's install graph.
cd scripts/demo
pnpm install --ignore-workspace
pnpm exec playwright install chromium    # download the headless browser
```

`ffmpeg` must be on `PATH`. On macOS: `brew install ffmpeg`. The
recorder will print a hint and bail if it's missing.

The Piper TTS path needs `piper-cli` + a voice model installed for
the embedded-llm package — see `packages/embedded-llm/README.md`.
The recorder calls `/api/voice/synthesize` on the running dev
server; if Piper isn't installed the API returns a 503 with the
exact `brew install piper` / model-download instructions.

## Running the recorder

```sh
# Terminal 1: boot the dev stack (API + worker + web).
pnpm dev

# Terminal 2: seed the sample profile (one-time per fresh DB).
pnpm db:seed

# Terminal 3: record.
cd scripts/demo
pnpm record
```

Output lands at `scripts/demo/out/demo.mp4`. Re-running the recorder
overwrites the screenshots but reuses the narration WAV cache, so
re-runs after a copy edit only re-synthesise the changed lines (~5s
on a warm Piper).

## Editing the script

Two surfaces:

- **[`timeline.json`](./timeline.json)** — cue points and Playwright
  actions per step. Adjust `durationSeconds` to retime, add an
  `action` to drive a new piece of UI, change the `voice` field to
  switch Piper models. Schema is validated at load time —
  `timeline.ts` will fail loud rather than ship a malformed video.
- **`narration` field on each step** — the text Piper turns into
  audio. Edits invalidate that step's cache automatically (cache key
  is sha256 of `voice + text`).

If you're editing the human-facing demo flow itself, edit
`docs/demo.md` first; the `timeline.json` is the recorder's
machine-readable view of that document and should stay in sync.

## Sub-commands

```sh
pnpm record           # full pipeline: screenshots → narration → mp4
pnpm narrate          # synthesise narration only (smoke-test Piper, find copy bugs early)
pnpm exec tsx src/assemble.ts  # re-mux without re-screenshotting (rare; you'd call assemble() yourself)
pnpm build            # `tsc --noEmit` typecheck
```

## Environment knobs

| Var | Default | When |
|---|---|---|
| `SKYTWIN_WEB_BASE` | `http://localhost:3200` | Web app URL |
| `SKYTWIN_API_BASE` | `http://localhost:3100` | API URL (Piper lives here) |
| `SKYTWIN_DEMO_USER_ID` | `demo-user` | `userId` sent to `/api/voice/synthesize` |

The recorder's pre-flight checks both base URLs and the
`/api/v1/demo/info` seed endpoint before touching Playwright, so a
forgotten `pnpm dev` fails in seconds rather than after a 60-second
screenshot loop.

## Determinism

The output is byte-deterministic given:

1. Same `timeline.json`
2. Same Piper voice model file (the embedded-llm dep)
3. Same seeded sample profile (the dashboard's content is what
   varies most across runs — the recorder pre-seeds the sample
   userId via Playwright's `addInitScript` rather than letting a
   real Gmail signal stream drift the on-screen state)
4. Same Playwright + Chromium minor versions (pinned via
   `pnpm install`'s lockfile)

In CI, all four are pinned by the lockfile + the dev container, so
the launch-video build is reproducible.

## Why this, not Selenium + ElevenLabs?

The reference pipeline this is adapted from (depobot's deposition
recorder) used Selenium + ElevenLabs. Both work, but each adds an
external dep this project doesn't need:

- **Playwright instead of Selenium:** modern API, native TypeScript,
  `addInitScript` for the localStorage pre-seed, built-in headless
  Chromium download. Same screenshot-at-N-fps strategy as Selenium;
  no need for an external ChromeDriver binary.
- **Piper instead of ElevenLabs:** the embedded-llm package already
  ships Piper for the voice loop. Using it here means the demo
  recorder has zero new runtime deps and zero API keys — the same
  binary that gives users on-device TTS in production also produces
  the launch-video narration. One TTS, one voice model, one set of
  failure modes to debug.

## Follow-ups

- The current pipeline produces 1280×800 (`viewport` in
  `timeline.json`); switch to 1920×1080 for HN-quality once Pretext
  or the design system has a wide-mode pass.
- The TTS voice (`en_US-amy-low`) is the smallest Piper voice
  available; the higher-fidelity variants need a larger model
  download but produce more natural narration. The recorder picks
  whatever voice id you set in `timeline.json` — change once, run.
- No music bed today. If a launch-video reviewer asks for a
  background pad, mix it in via a second `-i` to ffmpeg in
  `assemble.ts` — the filter graph already uses `amix`, so adding a
  third source is one line.
