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
#   2. Installs Homebrew (mac), Node 20+, pnpm, Docker, Ollama. Skips any
#      that are already on PATH.
#   3. Clones jayzalowitz/skytwin into ~/skytwin (or pulls latest if it's
#      already there).
#   4. Runs the project bootstrap (pnpm install, build, migrate, seed).
#   5. Starts CockroachDB, the API, the dashboard, the worker, and the
#      local LLM bridge.
#   6. Opens http://localhost:3200 in your browser.
#
# Re-running this script is safe — it pulls latest, restarts services, and
# opens the dashboard.

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
if [ -d "$INSTALL_DIR/.git" ]; then
  ok "Already cloned — pulling latest"
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  # Use --ff-only so we never overwrite uncommitted local changes.
  if ! git -C "$INSTALL_DIR" merge --ff-only "origin/$BRANCH" 2>/dev/null; then
    warn "Local changes detected — keeping your version, skipping pull."
  fi
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

# ── Step 3: start everything ───────────────────────────────────────────

step "Starting SkyTwin services"
if [ ! -x bin/skytwin-dev ]; then
  fail "bin/skytwin-dev is missing — installation appears incomplete."
fi

# bin/skytwin-dev starts CockroachDB (Docker), API, worker, dashboard,
# OpenClaw bridge, and supervises them with auto-restart. It logs to
# /tmp/skytwin-*.log and writes pids to .skytwin-pids.
#
# We start it in the background so this script can poll the dashboard
# and open it once it's up.
mkdir -p .logs
nohup ./bin/skytwin-dev --no-ollama >.logs/skytwin-dev.log 2>&1 &
DEV_PID=$!

trap 'kill $DEV_PID 2>/dev/null || true' INT TERM

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
  exit 1
fi

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
echo "Next: sign in with Google in the dashboard. The first run will guide"
echo "you through connecting your inbox and setting your trust level."
