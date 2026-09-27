#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$ROOT_DIR/.omp/config.yml"
SESSION_DIR="$ROOT_DIR/.runtime/omp/sessions"
MODE="${1:-interactive}"
shift || true

mkdir -p "$SESSION_DIR" "$ROOT_DIR/.runtime/omp/screenshots"

if ! command -v omp >/dev/null 2>&1; then
  echo "error: omp is not installed; run: npm install -g @oh-my-pi/pi-coding-agent" >&2
  exit 127
fi

OMP_VERSION="$(omp --version | grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | tail -n 1)"
if [[ -n "$OMP_VERSION" ]] && [[ "$(printf '%s\n' 18.3.2 "$OMP_VERSION" | sort -V | head -n 1)" != "18.3.2" ]]; then
  echo "error: OMP $OMP_VERSION is older than the supported project minimum 18.3.2; update with: npm install -g @oh-my-pi/pi-coding-agent@18.3.2" >&2
  exit 1
fi

if [[ -z "${OPENROUTER_API_KEY:-}" && -f "$ROOT_DIR/.env" ]]; then
  OPENROUTER_API_KEY="$(sed -n 's/^OPENROUTER_API_KEY=//p' "$ROOT_DIR/.env" | tail -n 1)"
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY%\"}"
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY#\"}"
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY%\'}"
  OPENROUTER_API_KEY="${OPENROUTER_API_KEY#\'}"
  export OPENROUTER_API_KEY
fi

if [[ -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "error: set OPENROUTER_API_KEY or add it to $ROOT_DIR/.env" >&2
  exit 2
fi

COMMON=(
  --cwd "$ROOT_DIR"
  --config "$CONFIG_FILE"
  --session-dir "$SESSION_DIR"
  --model openrouter/z-ai/glm-5.3
  --smol openrouter/deepseek/deepseek-v4.1-flash
  --slow openrouter/deepseek/deepseek-v4-pro-0813
  --plan openrouter/z-ai/glm-5.3
)

case "$MODE" in
  interactive)
    exec omp "${COMMON[@]}" "$@"
    ;;
  long)
    if [[ $# -eq 0 ]]; then
      echo "usage: pnpm harness:long -- \"task description\"" >&2
      exit 2
    fi
    PROMPT="$(cat "$ROOT_DIR/.omp/prompts/long-run.md")"$'\n\n'"USER TASK:"$'\n'"$*"
    if command -v caffeinate >/dev/null 2>&1; then
      exec caffeinate -i omp "${COMMON[@]}" --plan-yolo --approval-mode yolo --max-time 8h "$PROMPT"
    fi
    exec omp "${COMMON[@]}" --plan-yolo --approval-mode yolo --max-time 8h "$PROMPT"
    ;;
  resume)
    exec omp "${COMMON[@]}" --resume "$@"
    ;;
  doctor)
    echo "OMP: $(omp --version)"
    if [[ -n "$OMP_VERSION" ]]; then
      echo "Project minimum: 18.3.2 (installed $OMP_VERSION)"
    fi
    echo "Config: $CONFIG_FILE"
    echo "Sessions: $SESSION_DIR"
    omp models openrouter --config "$CONFIG_FILE" --json >/dev/null
    echo "OpenRouter model catalog: ok"
    if command -v git >/dev/null 2>&1 && command -v pnpm >/dev/null 2>&1; then
      echo "Required CLI tools: ok"
    else
      echo "error: git and pnpm are required" >&2
      exit 1
    fi
    if [[ -d "$ROOT_DIR/node_modules" ]]; then
      echo "Workspace dependencies: installed"
    else
      echo "Workspace dependencies: missing (run pnpm install)"
    fi
    ;;
  *)
    echo "usage: $0 {interactive|long|resume|doctor} [arguments...]" >&2
    exit 2
    ;;
esac
