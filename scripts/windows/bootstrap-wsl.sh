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
base_packages=(ca-certificates curl git jq ripgrep xz-utils build-essential python3 python3-venv)
missing_packages=()
for package_name in "${base_packages[@]}"; do
  dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q 'ok installed' || missing_packages+=("$package_name")
done
if ((${#missing_packages[@]})); then
  echo "install missing system packages: ${missing_packages[*]}"
  sudo apt-get update
  sudo apt-get install -y "${missing_packages[@]}"
else
  echo 'skip base system packages are already installed'
fi

if command -v docker >/dev/null 2>&1; then
  echo 'skip Docker CLI is already installed'
else
  echo 'install Docker Engine'
  sudo apt-get update
  sudo apt-get install -y docker.io
fi
if ! sudo docker info >/dev/null 2>&1; then
  sudo systemctl enable --now docker
fi
if sudo docker compose version >/dev/null 2>&1; then
  echo 'skip Docker Compose is already installed'
else
  echo 'install Docker Compose plugin'
  sudo apt-get update
  sudo apt-get install -y docker-compose-v2
fi
sudo usermod -aG docker "$USER"

mkdir -p "$HOME/.local/bin" "$HOME/.local/lib" "$HOME/projects"
if command -v node >/dev/null 2>&1 && [[ "$(node --version)" == v24.* ]] && command -v corepack >/dev/null 2>&1; then
  echo "skip compatible Node is already installed: $(node --version)"
else
  NODE_VERSION="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r '[.[] | select(.version | startswith("v24."))][0].version')"
  [[ "$NODE_VERSION" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || { echo 'Unable to resolve Node 24.' >&2; exit 1; }
  case "$(uname -m)" in
    x86_64) NODE_ARCH="x64" ;;
    aarch64) NODE_ARCH="arm64" ;;
    *) echo "Unsupported CPU architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_ARCHIVE="node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  NODE_ROOT="$HOME/.local/lib/node-${NODE_VERSION}"
  echo "install Node ${NODE_VERSION}"
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl -fsSLO --output-dir "$temp_dir" "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
  curl -fsSLo "$temp_dir/SHASUMS256.txt" "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
  (cd "$temp_dir" && grep " ${NODE_ARCHIVE}$" SHASUMS256.txt | sha256sum -c -)
  mkdir -p "$NODE_ROOT"
  tar -xJf "$temp_dir/$NODE_ARCHIVE" --strip-components=1 -C "$NODE_ROOT"
  for binary in node npm npx corepack; do ln -sfn "$NODE_ROOT/bin/$binary" "$HOME/.local/bin/$binary"; done
fi
export PATH="$HOME/.local/bin:$PATH"
if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version)" == '10.32.1' ]]; then
  echo 'skip pnpm 10.32.1 is already installed'
else
  corepack enable --install-directory "$HOME/.local/bin"
  corepack prepare pnpm@10.32.1 --activate
fi

if ! command -v codex >/dev/null 2>&1; then
  echo 'install Codex CLI'
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
else
  echo 'skip Codex CLI is already installed'
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
playwright_chromium="$(node -e "const { chromium } = require('playwright'); process.stdout.write(chromium.executablePath())")"
if [[ -x "$playwright_chromium" ]]; then
  echo 'skip Playwright Chromium is already installed'
else
  pnpm exec playwright install --with-deps chromium
fi
pnpm build

mkdir -p "$HOME/.local/state/coco"
service_file="$(mktemp)"
sed "s|@@REPO_ROOT@@|$REPO_ROOT|g; s|@@HOME@@|$HOME|g; s|@@USER@@|$USER|g" scripts/windows/coco-daemon.service.in >"$service_file"
if sudo test -f /etc/systemd/system/coco-daemon.service && sudo cmp -s "$service_file" /etc/systemd/system/coco-daemon.service; then
  echo 'skip Coco systemd unit is already installed'
else
  sudo install -m 0644 "$service_file" /etc/systemd/system/coco-daemon.service
fi
rm -f "$service_file"
sudo systemctl daemon-reload
sudo systemctl enable coco-daemon.service
sudo systemctl restart coco-daemon.service

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
