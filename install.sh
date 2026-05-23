#!/usr/bin/env bash
#
# SkyTwin one-command installer.
#
# Usage (the entire setup is this single line):
#
#   curl -fsSL https://raw.githubusercontent.com/jayzalowitz/skytwin/main/install.sh | bash
#
# Or if you already cloned the repo:
#
#   ./install.sh
#
# What it does (and only what's missing — never reinstalls anything you have):
#   1. Detects macOS / Linux / WSL.
#   2. Installs Homebrew (mac), Node 20+, pnpm. Skips any that are already
#      on PATH.
#   3. Fetches the official CockroachDB single-node binary (hash-verified)
#      into ~/.local/share/skytwin/bin/cockroach. NO Docker required.
#   4. Clones jayzalowitz/skytwin into ~/skytwin (or pulls latest if it's
#      already there).
#   5. Runs the project bootstrap (pnpm install, build, migrate, seed).
#   6. Starts CockroachDB, the API, the dashboard, and the worker.
#   7. Opens http://localhost:3200 in your browser.
#
# Re-running this script is safe — it pulls latest, restarts services, and
# opens the dashboard.
#
# Opt-in env vars (advanced):
#   SKYTWIN_USE_DOCKER=true     Use Docker for CRDB instead of the native
#                               binary (CI / legacy workflows).
#   SKYTWIN_WITH_OLLAMA=true    Also install Ollama + pull the gemma4
#                               model (9.6GB). Embedded llama.cpp is the
#                               default LLM and doesn't need this.

set -euo pipefail

REPO_URL="${SKYTWIN_REPO_URL:-https://github.com/jayzalowitz/skytwin.git}"
INSTALL_DIR="${SKYTWIN_INSTALL_DIR:-$HOME/skytwin}"
BRANCH="${SKYTWIN_BRANCH:-main}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step()   { echo -e "\n${BLUE}==>${NC} $*"; }
ok()     { echo -e "  ${GREEN}✓${NC} $*"; }
warn()   { echo -e "  ${YELLOW}!${NC} $*"; }
err()    { echo -e "  ${RED}✗${NC} $*" >&2; }

fail() {
  echo ""
  err "$1"
  echo ""
  echo "If you can't get past this on your own, open an issue:"
  echo "  https://github.com/jayzalowitz/skytwin/issues/new"
  exit 1
}

# ── Step 0: sanity ─────────────────────────────────────────────────────

OS="unknown"
case "$(uname -s)" in
  Darwin*) OS="mac" ;;
  Linux*)
    if grep -qi microsoft /proc/version 2>/dev/null; then
      OS="wsl"
    else
      OS="linux"
    fi
    ;;
  *) fail "Unsupported OS: $(uname -s). Mac, Linux, and WSL are supported." ;;
esac

step "SkyTwin installer (detected $OS)"

# Required for cloning.
if ! command -v git >/dev/null 2>&1; then
  fail "git is required but not installed. Install from https://git-scm.com/ and re-run."
fi

# ── Step 1: clone or update the repo ───────────────────────────────────

step "Fetching the SkyTwin repo into $INSTALL_DIR"
# Three states to handle:
#   - $INSTALL_DIR doesn't exist → clone from $REPO_URL.
#   - $INSTALL_DIR has a real .git directory → fetch + ff-only merge.
#   - $INSTALL_DIR has source but no .git directory (Conductor worktree
#     gitlinks, validation-harness untar, manual copy) → use as-is.
# Conductor worktrees ship .git as a 75-byte gitlink file pointing into
# a shared object store, so `[ -d $INSTALL_DIR/.git ]` returns false even
# though the repo is fully present. The `-e` check + `ls -A` fallback
# covers that and also handles a hand-extracted source tree.
if [ -e "$INSTALL_DIR/.git" ]; then
  # `-e` (not `-d`) so Conductor worktrees and any other gitlink-based
  # setup match here. In a worktree, `.git` is a 75-byte file pointing
  # at the shared object store, not a directory; `git -C` follows the
  # gitlink transparently so the fetch+merge below works either way.
  # The header comment above promised this behaviour; the previous `-d`
  # check silently fell through to the "no .git directory" branch and
  # skipped fetch+merge.
  ok "Already cloned — pulling latest"
  # Tolerate offline / sandboxed environments (validation containers, etc.)
  # where `origin` may not be reachable. The on-disk version is then used
  # as-is, which is exactly what the validation harness wants.
  if git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet 2>/dev/null; then
    # Use --ff-only so we never overwrite uncommitted local changes.
    if ! git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" 2>/dev/null; then
      warn "Local changes detected — keeping your version, skipping pull."
    fi
  else
    warn "Could not reach $REPO_URL — using the on-disk version as-is."
  fi
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  ok "Found existing source at $INSTALL_DIR (no .git directory) — using as-is"
else
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "Cloned"
fi

cd "$INSTALL_DIR"

# ── Step 2: install dependencies ───────────────────────────────────────

step "Installing prerequisites (skips anything already on your machine)"
if [ ! -x bin/skytwin-install ]; then
  fail "bin/skytwin-install is missing. The repo may be incomplete — re-run this installer."
fi

# bin/skytwin-install handles Homebrew / Node / pnpm / Docker / Ollama
# detection and only installs what's missing. It exits non-zero only on
# real failure, so we forward its exit code rather than burying it.
./bin/skytwin-install

# ── Step 2.5: Docker daemon (only when explicitly using Docker) ────────
#
# In the default (native CRDB) path we don't need Docker at all. Only run
# this check when the user opted into Docker via SKYTWIN_USE_DOCKER=true,
# because a fresh `brew install --cask docker` leaves Docker Desktop
# installed but not running, which used to surface later as a confusing
# CockroachDB startup error.

if [ "${SKYTWIN_USE_DOCKER:-false}" = "true" ]; then
  step "Checking that Docker is running (SKYTWIN_USE_DOCKER=true)"
  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker isn't on PATH yet. If you just installed Docker Desktop, open it once and re-run this script."
  elif docker info >/dev/null 2>&1; then
    ok "Docker daemon is running"
  else
    warn "Docker is installed but the daemon isn't responding yet."
    case "$OS" in
      mac)
        if [ -d "/Applications/Docker.app" ]; then
          echo "  Starting Docker Desktop…"
          open -a Docker || true
          echo -n "  Waiting for Docker to come up "
          for _ in $(seq 1 60); do
            if docker info >/dev/null 2>&1; then echo ""; ok "Docker is ready"; break; fi
            echo -n "."
            sleep 1
          done
          if ! docker info >/dev/null 2>&1; then
            echo ""
            fail "Docker still isn't responding. Open Docker Desktop manually, wait for the whale icon to settle, then re-run this script."
          fi
        else
          fail "Docker Desktop isn't installed in /Applications. Install it from https://docker.com and re-run this script."
        fi
        ;;
      linux)
        echo "  Trying: sudo systemctl start docker"
        sudo systemctl start docker 2>/dev/null || true
        sleep 2
        if ! docker info >/dev/null 2>&1; then
          fail "Docker daemon isn't running. Start it with: sudo systemctl start docker"
        fi
        ok "Docker is ready"
        ;;
      wsl)
        fail "Docker isn't reachable from WSL. Open Docker Desktop on Windows and enable 'Use the WSL 2 based engine' + 'WSL integration' for this distro, then re-run."
        ;;
      *)
        fail "Docker isn't running. Start it and re-run this script."
        ;;
    esac
  fi
fi

# ── Step 3: start everything ───────────────────────────────────────────

step "Starting SkyTwin services"
if [ ! -x bin/skytwin-dev ]; then
  fail "bin/skytwin-dev is missing — installation appears incomplete."
fi

# bin/skytwin-dev starts CockroachDB (native binary by default), API,
# worker, dashboard, and optionally the OpenClaw bridge if Ollama was
# explicitly installed. It supervises them with auto-restart, logs to
# /tmp/skytwin-*.log and writes pids to .skytwin-pids.
#
# We start it in the background so this script can poll the dashboard
# and open it once it's up. Ollama is opt-in (SKYTWIN_WITH_OLLAMA=true);
# in the default install the OpenClaw bridge is skipped because the
# embedded llama.cpp provider handles LLM calls without a 9.6GB model
# download. Pass --use-docker through if the user opted into Docker.
mkdir -p .logs
DEV_ARGS=()
if [ "${SKYTWIN_USE_DOCKER:-false}" = "true" ]; then
  DEV_ARGS+=(--use-docker)
fi
if [ "${SKYTWIN_WITH_OLLAMA:-false}" != "true" ]; then
  DEV_ARGS+=(--no-ollama)
fi
nohup ./bin/skytwin-dev "${DEV_ARGS[@]}" >.logs/skytwin-dev.log 2>&1 &
DEV_PID=$!

# On any exit (success, INT, TERM, dashboard timeout), make sure we
# don't leave a half-started service tree behind.
cleanup_on_failure() {
  if [ -n "${DEV_PID:-}" ]; then
    ./bin/skytwin-dev --stop 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
  fi
}
trap 'cleanup_on_failure' INT TERM

# ── Step 4: wait for the dashboard, then open it ───────────────────────

step "Waiting for the dashboard to come online (up to 90s)"
DASHBOARD_URL="http://localhost:3200"
DEADLINE=$(( $(date +%s) + 90 ))

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf -o /dev/null "$DASHBOARD_URL"; then
    ok "Dashboard is up"
    break
  fi
  sleep 2
done

if ! curl -sf -o /dev/null "$DASHBOARD_URL"; then
  err "Dashboard didn't come online within 90s."
  echo "  Check the logs at:    .logs/skytwin-dev.log"
  echo "  Stop the services:    ./bin/skytwin-dev --stop"

  # Surface the most useful diagnostic lines immediately so the user (or
  # the validation harness) doesn't need to dig through five log files
  # to find the cause. We tail each one separately so a missing log
  # doesn't suppress the others.
  for log in .logs/skytwin-dev.log .logs/skytwin-api.log .logs/skytwin-web.log .logs/skytwin-worker.log; do
    if [ -s "$log" ]; then
      echo ""
      echo "  --- $log (tail 30) ---"
      tail -n 30 "$log" 2>/dev/null | sed 's/^/    /'
    fi
  done
  echo ""

  cleanup_on_failure
  exit 1
fi

# Past the danger zone — the supervisor is healthy and we don't want the
# trap to nuke it on a benign script-level signal.
trap - INT TERM

case "$OS" in
  mac)   open "$DASHBOARD_URL" ;;
  linux) command -v xdg-open >/dev/null 2>&1 && xdg-open "$DASHBOARD_URL" >/dev/null 2>&1 || true ;;
  wsl)   command -v wslview >/dev/null 2>&1 && wslview "$DASHBOARD_URL" >/dev/null 2>&1 || true ;;
esac

echo ""
echo -e "${GREEN}=== SkyTwin is running ===${NC}"
echo ""
echo -e "  Dashboard:    ${BLUE}$DASHBOARD_URL${NC}"
echo -e "  Logs:         ${BLUE}$INSTALL_DIR/.logs/skytwin-dev.log${NC}"
echo -e "  Stop:         ${YELLOW}cd $INSTALL_DIR && ./bin/skytwin-dev --stop${NC}"
echo -e "  Restart:      ${YELLOW}cd $INSTALL_DIR && ./install.sh${NC}"
echo ""

# Tailor the next-step message to whether Google credentials are wired up.
# /api/credentials/status returns { google: { configured: bool }, ... } and
# is reachable on localhost without auth in dev mode.
GOOGLE_STATUS="$(curl -sf "http://localhost:3100/api/credentials/status" 2>/dev/null || true)"
if echo "$GOOGLE_STATUS" | grep -q '"configured":true'; then
  echo "Next: open the dashboard and click 'Continue with Google' to sign in."
  echo "Your twin will start learning from your inbox and calendar right away."
else
  echo "Next: open the dashboard. You'll see a 'Set up Google access' card —"
  echo "click it for a 5-minute walkthrough that wires up your Gmail + Calendar."
  echo ""
  echo "Already done that elsewhere? Paste your existing Google OAuth Client ID"
  echo "and Secret in Setup → Google account credentials and you're off."
fi
