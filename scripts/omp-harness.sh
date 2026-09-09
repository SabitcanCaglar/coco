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
  --model openrouter/qwen/qwen3-coder-next
  --smol openrouter/z-ai/glm-5.3-flash
  --slow openrouter/deepseek/deepseek-v3.2
  --plan openrouter/qwen/qwen3-coder-next
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
      exec caffeinate -i omp "${COMMON[@]}" --plan-yolo --plan-yolo-into smol --approval-mode yolo --max-time 8h "$PROMPT"
    fi
    exec omp "${COMMON[@]}" --plan-yolo --plan-yolo-into smol --approval-mode yolo --max-time 8h "$PROMPT"
    ;;
  resume)
    exec omp "${COMMON[@]}" --resume "$@"
    ;;
  doctor)
    echo "OMP: $(omp --version)"
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
