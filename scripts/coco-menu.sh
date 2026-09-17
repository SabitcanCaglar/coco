#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HARNESS="$ROOT_DIR/scripts/omp-harness.sh"

cd "$ROOT_DIR"

clear_screen() {
  printf '\033[2J\033[H'
}

pause() {
  printf '\nDevam etmek icin Enter...'
  read -r
}

header() {
  clear_screen
  cat <<'EOF'

        /\_____/\
       /  o   o  \
      ( ==  ^  == )     COCO CONTROL CENTER

  Pi / OMP uzun kosulu coding harness
  Qwen Coder · GLM Flash · DeepSeek · Chromium

EOF
}

run_long_task() {
  header
  printf 'Coco ne yapsin?\n\n> '
  read -r task
  if [[ -z "$task" ]]; then
    printf '\nGorev bos birakildi.\n'
    pause
    return
  fi

  printf '\nCalisma basliyor. Durdurmak icin Ctrl+C.\n\n'
  "$HARNESS" long "$task"
  pause
}

show_models() {
  header
  cat <<'EOF'
Model rolleri

  Ana kodlama     Qwen3 Coder Next
  Hizli / ucuz    GLM 5.3 Flash
  Zor problemler  DeepSeek V3.2
  Son yedek       Kimi K2.5
  Ucretsiz yedek  Step 3.5 Flash Free

Model gecisleri ve hata durumundaki fallback otomatik yonetilir.
EOF
  pause
}

while true; do
  header
  cat <<'EOF'
  [1] Yeni uzun gorev baslat
  [2] Pi ile interaktif calis
  [3] Eski oturuma devam et
  [4] Sistem kontrolu
  [5] Model ve maliyet profili
  [0] Cikis

EOF
  printf 'Secim: '
  read -r choice

  case "$choice" in
    1) run_long_task ;;
    2) "$HARNESS" interactive; pause ;;
    3) "$HARNESS" resume; pause ;;
    4) header; "$HARNESS" doctor; pause ;;
    5) show_models ;;
    0) clear_screen; exit 0 ;;
    *) printf '\nGecersiz secim.\n'; sleep 1 ;;
  esac
done
