#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/SabitcanCaglar/coco.git"
BRANCH="codex/m6-first-real-fixers"
SKIP_TESTS=false

while (($#)); do
  case "$1" in
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --branch) BRANCH="$2"; shift 2 ;;
    --skip-tests) SKIP_TESTS=true; shift ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$REPO_URL" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(\.git)?$ ]] || { echo 'Unsafe repository URL.' >&2; exit 2; }
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || { echo 'Unsafe branch.' >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive
if [[ -n "${OPENAI_API_KEY:-}" || -n "${OPENROUTER_API_KEY:-}" ]]; then
  echo 'Paid API credentials are present. Unset them before a Pro-only installation.' >&2
  exit 1
fi
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq ripgrep xz-utils build-essential python3 python3-venv docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

mkdir -p "$HOME/.local/bin" "$HOME/.local/lib" "$HOME/projects"
NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v24."))][0].version')"
[[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || { echo 'Unable to resolve Node 24.' >&2; exit 1; }
case "$(uname -m)" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64) NODE_ARCH="arm64" ;;
  *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
esac
NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_ROOT="$HOME/.local/lib/node-${NODE_VERSION}"
if [[ ! -x "$NODE_ROOT/bin/node" ]]; then
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl -fsSLO --output-dir "$temp_dir" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
  curl -fsSLo "$temp_dir/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$temp_dir" && grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$NODE_ROOT"
  tar -xJf "$temp_dir/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_ROOT"
fi
for binary in node npm npx corepack; do ln -sfn "$NODE_ROOT/bin/$binary" "$HOME/.local/bin/$binary"; done
export PATH="$HOME/.local/bin:$PATH"
corepack enable --install-directory "$HOME/.local/bin"
corepack prepare pnpm@10.32.1 --activate

if ! command -v codex >/dev/null 2>&1; then
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
fi
export PATH="$HOME/.local/bin:$HOME/.codex/bin:$PATH"
mkdir -p "$HOME/.codex"
if [[ ! -f "$HOME/.codex/config.toml" ]]; then
  cat >"$HOME/.codex/config.toml" <<'EOF'
approval_policy = "never"
sandbox_mode = "danger-full-access"
EOF
  chmod 0600 "$HOME/.codex/config.toml"
fi

REPO_ROOT="$HOME/projects/coco"
if [[ -d "$REPO_ROOT/.git" ]]; then
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    echo "Existing Coco checkout is dirty; refusing to overwrite: $REPO_ROOT" >&2
    exit 1
  fi
  git -C "$REPO_ROOT" fetch origin "$BRANCH"
  git -C "$REPO_ROOT" checkout "$BRANCH"
  git -C "$REPO_ROOT" pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$REPO_ROOT"
fi

cd "$REPO_ROOT"
[[ -f coco.projects.json ]] || cp coco.projects.example.json coco.projects.json
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
pnpm build

mkdir -p "$HOME/.local/state/coco"
service_file="$(mktemp)"
sed "s|@@REPO_ROOT@@|$REPO_ROOT|g; s|@@HOME@@|$HOME|g; s|@@USER@@|$USER|g" scripts/windows/coco-daemon.service.in >"$service_file"
sudo install -m 0644 "$service_file" /etc/systemd/system/coco-daemon.service
rm -f "$service_file"
sudo systemctl daemon-reload
sudo systemctl enable --now coco-daemon.service

if [[ "$SKIP_TESTS" == false ]]; then
  pnpm host:doctor
  pnpm typecheck
  pnpm test
  pnpm lint
  pnpm test:browser:headless
  curl --fail --silent --show-error --retry 20 --retry-delay 1 http://127.0.0.1:3000/health | jq -e '.status == "ok"' >/dev/null
fi

jq -n \
  --arg installedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg repoRoot "$REPO_ROOT" \
  --arg branch "$BRANCH" \
  --arg head "$(git rev-parse HEAD)" \
  --arg node "$(node --version)" \
  --arg pnpm "$(pnpm --version)" \
  '{installedAt:$installedAt,repoRoot:$repoRoot,branch:$branch,head:$head,node:$node,pnpm:$pnpm,headless:true}' \
  >"$HOME/.local/state/coco/install-report.json"

echo "Coco headless worker installed at $REPO_ROOT"
echo "Report: $HOME/.local/state/coco/install-report.json"
