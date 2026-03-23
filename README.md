# coco

```
        /\_____/\
       /  o   o  \
      ( ==  ^  == )
       )         (
      (           )
     ( (  )   (  ) )
    (__(__)___(__)__)

    ██████╗ ██████╗  ██████╗ ██████╗
   ██╔════╝██╔═══██╗██╔════╝██╔═══██╗
   ██║     ██║   ██║██║     ██║   ██║
   ██║     ██║   ██║██║     ██║   ██║
   ╚██████╗╚██████╔╝╚██████╗╚██████╔╝
    ╚═════╝ ╚═════╝  ╚═════╝ ╚═════╝
```

> **coco** — kedim coco'nun adını taşıyan, Linus Torvalds felsefesiyle inşa edilmiş,
> kendi kendini iyileştiren çok-proje mühendislik orkestratörü.

---

## Felsefe

> "Talk is cheap. Show me the code." — Linus Torvalds

Gösterişli framework yerine sağlam boru hattı.
Tek dev makinede, izole `git worktree`'lerde paralel çalışan coding agent'lar.
Her karar ölçülebilir, her değişiklik test edilmiş, hiçbir merge review'suz geçmez.

---

## Mimari

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                         │
│   görev seç → önceliklendir → hangi worker → dispatch  │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ worker-1│  │ worker-2│  │ worker-3│
   │ repo-a  │  │ repo-b  │  │ repo-c  │
   │worktree │  │worktree │  │worktree │
   └────┬────┘  └────┬────┘  └────┬────┘
        └────────────┴────────────┘
                     │
              ┌──────▼──────┐
              │ REVIEW GATE │
              │ lint→test   │
              │ diff→merge  │
              └─────────────┘
```

### Katmanlar

| Katman | Sorumluluk |
|--------|-----------|
| **Orchestrator** | Görev kuyruğu, worker atama, kapasite yönetimi |
| **Worker** | Tek repo / tek branch / tek worktree içinde çalışır |
| **Doctor Engine** | Her projeyi triaj → vitaller → teşhis → tedavi hattıyla analiz eder |
| **LLM Registry** | Ollama / Claude / OpenAI / NullProvider — plug & play |
| **Review Gate** | Lint + test + diff review; onaysız merge yok |

---

## Doctor Engine — "Her Projeyi Handle Eden Sistem"

Gerçek doktor metaforuyla çalışır:

```
1. TRIAJ        → Ne tür proje? Acil sorun var mı?
2. VITALLER     → Sayısal sağlık metrikleri
3. ANAMNEZ      → Git geçmişi, hotspot analizi
4. MUAYENE      → Framework-spesifik uzman kontrolleri
5. LAB          → Semgrep, complexity, dependency graph
6. TEŞHİS       → Bulgulardan hastalık çıkarma
7. TEDAVİ       → Önceliklendirilmiş reçete + ADR üretme
8. TAKİP        → Tedavi işe yaradı mı?
```

Desteklenen framework uzmanları: Next.js, Supabase, Prisma, Drizzle,
Express/Hono/Fastify, Django, Docker, Go, Rust, Rails, Laravel, Flutter (plugin).

---

## LLM Provider

```
provider: "auto"   →   API key varsa → kullan
                        Ollama varsa  → kullan
                        Hiçbiri yoksa → NullProvider (deterministik mod)
```

LLM olmadan tüm AST analizi, Semgrep, complexity ve graph taraması çalışır.
LLM sadece açıklama üretme ve ADR yazma için gereklidir.

```bash
# Ollama (local, ücretsiz)
ollama pull deepseek-coder-v2:16b
ollama pull nomic-embed-text

# veya API key
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

---

## Kurulum

### Docker ile (önerilen)

```bash
git clone https://github.com/canfamily/coco
cd coco
cp .env.example .env
docker compose up -d
```

### Local

```bash
pnpm install
pnpm build
pnpm dev
```

---

## Kullanım

```bash
# Projeyi muayene et
npx coco audit /path/to/your/project

# Tüm kayıtlı projeleri tara
npx coco audit --all

# Spesifik uzman çalıştır
npx coco audit --expert nextjs /path/to/project

# Worker başlat
npx coco worker start --project my-saas

# Orchestrator dashboard
npx coco dashboard
```

### Örnek çıktı

```
  COCO — Architectural Health Examination
  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  TRIAJ    Next.js 14 + Prisma + Supabase
  VITALLER Files: 127 | Complexity avg: 4.2 | Tests: 0.09 ratio
  SONUC    Score: 34/100 (D) — 5 condition, 2 critical

  ONCELIK 1  Exposed credentials in .env        30 min
  ONCELIK 2  service_role key in client code     1 hour
  ONCELIK 3  God Route (847 lines)               4 hours
```

---

## Proje Yapısı

```
coco/
  packages/
    core/           LLM registry, Doctor Engine, AST parsing
    orchestrator/   Görev kuyruğu, worker yönetimi
    worker/         Tek-proje coding agent session
    review/         Lint, test, diff review gate
    cli/            npx coco komutları
  docker/
    compose.yml
    Dockerfile.orchestrator
    Dockerfile.worker
  docs/
    adr/            Architecture Decision Records
    experts/        Framework uzman dokümantasyonu
  harden.config.json
```

---

## Katkı

1. Fork → feature branch → küçük patch'ler
2. Her patch sonrası test zorunlu
3. PR özeti olmadan merge yok
4. Review agent onaylamadan merge olmaz

```bash
git worktree add ../coco-feature-x feature/x
cd ../coco-feature-x
# ... çalış ...
pnpm test
gh pr create
```

---

## Lisans

MIT — Açık kaynak. Linus felsefesiyle: kodu konuş, taahhüdü gör.

---

*coco — kedimin adı, sistemin ruhu.*
