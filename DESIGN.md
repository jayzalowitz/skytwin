# Design System — SkyTwin

Source of truth for every visual and UI decision. Read this before touching UI.
Created by /design-consultation, grounded in a full element-and-state inventory of
the digest surfaces (web `twin-briefing.js` / `dashboard-view.js`, mobile
`BriefingScreen.tsx`), the existing tokens in `apps/web/public/css/styles.css`, and
the data shapes in `@skytwin/decision-engine` (`digest.ts`, `digest-detail.ts`,
`source-coverage.ts`) + `@skytwin/shared-types` enums.

## Product Context
- **What this is:** a digital twin's daily briefing/digest. It reads your signals
  (email, calendar, files, voice), splits what needs you from what's awareness, and
  acts on your behalf under trust + policy gates.
- **Who it's for:** two audiences at once. A non-technical default (calm, safe,
  legible) and a power user who flips on depth (provenance, confidence, why).
- **The memorable thing:** "careful software that quietly handled things for me."
  Trust and calm over flash. Every choice serves that.

## Aesthetic Direction
- **Direction:** Calm command center. Premium, function-led. Restraint, generous
  air, refined type, crisp edges. Not a dashboard, not a toy.
- **Decoration level:** minimal. Type, spacing, and one accent do the work. Depth
  comes from a single soft elevation shadow, not ornament.
- **Function leads:** every element earns its place by serving a product purpose —
  triage (what needs you), action (do it here), trust (where it came from, why).

## Color — color is meaning, never decoration
Cool-neutral dark base (refines the existing tokens; zero brown). Exactly ONE accent,
and it means **"needs your attention / act here."** Reserve every other hue for a
specific meaning.

| Token | Value | Meaning / usage |
|-------|-------|-----------------|
| `--bg` | `#0E0F13` | App background (deep cool-neutral) |
| `--surface` | `#16181F` | Cards, the digest |
| `--elevated` | `#1D2029` | Raised panels, power-view detail, hover |
| `--border` | `#272B38` | Hairline separators |
| `--border-strong` | `#363B4C` | Focus ring, hover border |
| `--text` | `#ECEDF1` | Primary text |
| `--text-muted` | `#9CA0AE` | Secondary text, labels |
| `--text-dim` | `#5E6374` | Tertiary, timestamps, refs |
| `--accent` (iris) | `#7C72E8` | THE accent: needs-you, primary actions, deadline pill, to-do edge. Nothing else. |
| `--accent-hover` | `#9A92F2` | Accent hover |
| `--accent-soft` | `rgba(124,114,232,.16)` | Accent fill behind pills/primary chips |
| `--danger` | `#F26D5B` | Security alerts + destructive only. Never decorative. |
| `--danger-soft` | `rgba(242,109,91,.13)` | |
| `--safe` | `#46C08A` | "Available" / "handled on my own" / safe status |
| `--warning` | `#E7B14C` | "Partial" coverage only |

Discipline that fixes the old chip-soup: **accent is rare.** If two things on a row
are accent-colored, one is wrong. Provenance, source-type, and topics are all neutral.

**Light mode:** invert surfaces (bg `#FAFAFB`, surface `#FFFFFF`, text `#1A1B20`),
keep the same accent, drop accent/danger fills to ~10% alpha. Derive, do not redesign.

## Typography
- **Voice (display):** **Fraunces** (opsz on; weight 500). Used ONLY for the twin's
  one-line opener ("Three things need you this morning."). The serif is the
  signature: it separates the twin's words from your content and reads considered,
  human, trustworthy. Never use it for UI chrome.
- **Everything structural:** **Geist** (400/450/500/600). Headings, to-dos, labels,
  buttons, body. Calm and legible at small sizes.
- **Data / refs / confidence / IDs:** **Geist Mono** (400/500). The mono IS the
  visual cue for the technical (power) layer.
- **Loading:** Google Fonts (`Fraunces`, `Geist`, `Geist Mono`) or self-host under
  `apps/web/public/fonts`. Preconnect; `display=swap`.
- **Blacklist:** never Inter, Roboto, Space Grotesk, system-ui as display/body (the
  convergence trap).
- **Scale (px):** voice 25 / section-label 12 (600, uppercase, muted) / to-do 15 /
  topic-item 13.5 / meta 12 / mono 11.5. Line-height 1.5 body, 1.28 voice.

## Spacing
- **Base unit:** 4px. **Density:** comfortable (the to-do is the hero; give it air).
- **Scale:** 2xs(2) xs(4) sm(8) md(12) lg(16) xl(24) 2xl(32) 3xl(48) 4xl(64).
- Row padding 13px vertical; section gap 18–24px; card padding 24–26px.

## Layout
- **Approach:** single focused reading column. A digest is read top to bottom, not
  scanned as a grid. **Max width ~680px.**
- **Hierarchy is the layout:** the To-dos block is the action zone (accent edge,
  checkboxes, inline actions); Topics is the awareness zone (lighter, no edge, no
  checkbox, smaller). The eye must know "act vs. catch up" without reading.
- **Radius:** card 14, control/row 8, button 6, pill 999. Crisp, not bubbly.

## Motion
- **Approach:** minimal-functional. Only motion that aids comprehension.
- **Duration:** micro 120ms (toggles, hover), short 180ms (expand/collapse,
  check-off), avoid anything longer. **Easing:** ease-out for enter, ease-in for exit.
- Row actions reveal on hover/focus (calm at rest). Reduced-motion: no transitions.

---

## Component & State Catalog
Every element, what it binds to, and EVERY state it must handle. States marked
**(GAP)** exist in the data/logic today but were never rendered. The system designs
them now; do not ship the element without them.

### Twin voice opener
Binds: `briefing` summary. Fraunces, 25px. One line ("Three things need you this
morning."). States: with-todos / all-quiet ("You're all caught up.") / cold-start
("Connect a source and I'll start your briefing.").

### Value line
Binds: counts derived from outcomes. `✓ N handled on my own · M need you · K to catch
up`. The `✓ handled` segment uses `--safe`. Proves the twin earned its keep. State:
hide the "handled" segment when zero.

### To-do row (action zone) — `DigestTodo`
Left edge 2px `--accent` (`--danger` for security). Checkbox + provenance dot + text
+ optional deadline pill + inline actions (hover/focus reveal).
- **default** / **hover-focus** (actions appear) / **checked → completing** (180ms,
  accent check, row fades) / **with-deadline** (accent pill `in 2 days`) /
  **overdue** (GAP — pill flips to `--danger`) /
  **security/danger** (red edge, no checkbox, hint "open your provider directly,"
  action `Verify in app`) /
  **scope-blocked (GAP)** — when `detail.whyNotAutoExecuted` includes
  `missing_write_scope`, the primary action becomes a quiet `Grant access` (not a
  filled accent button; it's a request, not a one-click act) /
  **provenance**: filled dot `--text-muted` = "from you", hollow dot `--text-dim` =
  inbound. Provenance is NEVER accent-colored.

### Inline row actions
Binds: action types (`send_reply`, `respond_to_event`, escalate…). Primary = filled
accent (`Draft reply`, `Accept`); secondary = outline (`Snooze`, `Propose new`).
Security primary = filled `--danger`. At most one primary per row. Reveal on
hover/focus; on touch, always visible.

### Source-type indication — `sourceType`
NOT a row of CAPS chips (that was the chip-soup). A single small monochrome glyph +
accessible label (email, calendar, file, voice, app). One mark, neutral, never accent.
Unknown type → neutral dot, never crashes.

### Citation — `signalRefs[]`
NOT repeated "source" buttons. A single quiet affordance per row (a small "·N
sources" link or an icon) that opens the in-app signal/decision detail. NEVER a raw
external URL (safety #8). Hover: `--text`.

### Topic group (awareness zone) — `DigestTopic`
Domain title (12px muted) + lighter item rows: no edge, no checkbox, smaller (13.5px),
neutral. Visibly recedes from the to-do zone. State: empty → omit the group.

### Power-view toggle
Header, right. Persisted. `aria-pressed`. Off by default (clean view is the default;
non-technical users never see depth unless they ask). On: all detail panels expand +
coverage panel shows.

### Per-item detail panel — `DigestItemDetail`
`--elevated` panel, mono refs. Rows: origin (provenance label) / confidence (% — show
as text + a thin accent bar) / urgency (the reason) / not-auto-run (humanized block
reasons) / refs (mono) / why (explanation). States: collapsed (per-row toggle) /
expanded / forced-open (power view) / absent (no detail → no expander).

### Coverage panel — `SourceCoverage`
Power view. Per capability: status dot (`--safe` available / `--warning` partial /
`--text-dim` unavailable) + name + "connect X to unlock Y". 
**Cold-start (GAP):** when `coverage.coldStart` is true (zero connectors), this is NOT
a panel buried in power view — it's the PRIMARY surface: a designed "Connect a source
to begin" state listing connectable providers. This is the new user's first moment;
design it, don't fall through to "nothing yet."

### Digest container — states (several are GAPs)
- **loading (GAP):** skeleton rows (shimmer at reduced-motion-safe), not a bare
  "Loading…".
- **populated:** the digest.
- **empty-quiet:** connected but nothing today → the voice line "You're all caught
  up." + the value line. Calm, not blank.
- **cold-start (GAP):** zero connectors → the coverage cold-start surface above.
- **error / API-fail (GAP):** a contained, human error card with Retry. Never a
  white void; never swallow.
- **prose-fallback:** no `structured` payload → render `prose_markdown`. When
  structured IS present, prose collapses under a "Full briefing" disclosure.

### Dashboard briefing card (`dashboard-view.js`)
Binds: `briefing.items[]`. Mirror the digest language: accent edge = needs-you, safe =
handled. Summary headline. States: loading / empty (hide) / cold-start / error. Today
it hides when empty — give it a cold-start nudge instead.

### Mobile BriefingScreen (`BriefingScreen.tsx`)
Same system, same hierarchy. Has loading/error/empty already; bring it to digest
parity (to-dos with actions, source mark, the two-zone hierarchy). Touch: actions
always visible (no hover).

---

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-07 | Calm command center; premium, function-led | Trust product + daily surface → restraint beats flash; serves both audiences via clean-default + power-view |
| 2026-06-07 | Iris `#7C72E8` as the ONE accent = "needs you / act" | Premium, refines the existing `#6c7bff`, avoids the convergent generic blue; single-accent discipline kills the chip-soup |
| 2026-06-07 | Rejected warm/brown base | Read as sepia sludge; the real app is cool-neutral — align to it, deepen for premium |
| 2026-06-07 | Fraunces for the twin's voice only | A serif signature reads human/considered/trustworthy and separates the twin's words from content |
| 2026-06-07 | To-dos are an action zone (checkbox + inline actions), Topics an awareness zone | The "it can act" thesis must be visible; hierarchy encodes act-vs-catch-up |
| 2026-06-07 | Every state cataloged incl. cold-start, scope-blocked, loading, error | Boil the lake: design all states, not the happy path |
