#!/usr/bin/env bash
set -euo pipefail

failures=0

check_command() {
  local command_name="$1"
  if command -v "$command_name" >/dev/null 2>&1; then
    printf 'ok   %s\n' "$command_name"
  else
    printf 'miss %s\n' "$command_name" >&2
    failures=$((failures + 1))
  fi
}

printf 'Coco headless host doctor\n'
check_command git
check_command node
check_command pnpm
check_command docker
check_command rg

if [[ -r /proc/version ]] && grep -qi microsoft /proc/version; then
  printf 'ok   WSL2/Linux execution environment\n'
elif [[ "$(uname -s)" == "Linux" ]]; then
  printf 'ok   Linux execution environment\n'
else
  printf 'warn expected WSL2/Linux for the Windows worker; detected %s\n' "$(uname -s)"
fi

if docker info >/dev/null 2>&1; then
  printf 'ok   Docker engine reachable\n'
else
  printf 'miss Docker engine is not reachable\n' >&2
  failures=$((failures + 1))
fi

if [[ -f coco.projects.json ]]; then
  printf 'ok   coco.projects.json present\n'
else
  printf 'miss copy coco.projects.example.json to coco.projects.json and configure paths\n' >&2
  failures=$((failures + 1))
fi

if grep -Eq '^[[:space:]]*headless:[[:space:]]*true' .omp/config.yml; then
  printf 'ok   OMP browser is headless\n'
else
  printf 'miss OMP headless browser policy\n' >&2
  failures=$((failures + 1))
fi

if [[ -n "${OPENAI_API_KEY:-}" || -n "${OPENROUTER_API_KEY:-}" ]]; then
  printf 'warn paid API credentials are present in this shell; Pro-only runs must unset them\n'
else
  printf 'ok   no paid API credential detected in the current shell\n'
fi

if (( failures > 0 )); then
  printf 'Headless host is not ready: %d required check(s) failed.\n' "$failures" >&2
  exit 1
fi

printf 'Headless host prerequisites passed.\n'
