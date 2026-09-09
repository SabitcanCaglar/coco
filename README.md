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

> **Self-improving code health for every project. Free as in freedom.**

---

## Manifesto

> "Talk is cheap. Show me the code." — Linus Torvalds

We believe the tools that shape software should be **free, open, and owned by everyone**.

Not free as in "free trial." Free as in **freedom** — the freedom to run, study, modify, and share.
The same freedom Linus gave the world with Linux. The same freedom that built the internet,
Git, GCC, and every tool we rely on without thinking.

**coco** exists because:

1. **Code health is a right, not a premium feature.** Every solo developer and open source
   maintainer deserves the same code quality tools that billion-dollar companies hoard behind
   enterprise paywalls. coco runs on your machine, with your models, for $0.

2. **LLMs should serve the developer, not the vendor.** coco works without any API key.
   Deterministic analysis first. Local LLMs (Ollama) when you want smarter hypotheses.
   Cloud APIs only if *you* choose to. No telemetry. No lock-in. Your code never leaves
   your machine unless you decide it should.

3. **Simplicity is not a compromise — it's the architecture.** A pipe is better than a
   framework. A function is better than a class hierarchy. A working prototype is better
   than a perfect design document. We follow the Unix way: do one thing well, compose
   with others, fail loudly.

4. **Every change must prove itself.** No commit enters the codebase on faith. coco's
   Karpathy Loop — observe, hypothesize, experiment, evaluate — means every improvement
   is measured, tested in isolation, and only merged when the numbers go up. If a change
   doesn't improve the score, it gets reverted. No exceptions.

5. **Open source is not a license — it's a pact.** We ship everything: the good code,
   the ugly code, the failed experiments. We review in public. We discuss in public.
   We build in public. Because the best code comes from the most eyes.

```
The cathedral model says: plan everything, hide the mess, reveal the masterpiece.
The bazaar model says: ship early, ship often, let the community shape the code.
We choose the bazaar — every single time.

                                            — coco contributors
```

This is software built by developers, for developers, in the spirit of the tools
we all depend on. If you believe code health should be free, you're in the right place.

---

## What is coco?

A **self-improving code health engine** that examines your projects like a doctor examines
a patient. Named after my cat. Built with the Karpathy Loop — the same
observe→hypothesize→experiment→evaluate cycle that drives autonomous research — adapted
for software engineering.

Three primitives. That's all:
- **Editable Asset** — your project code, isolated in a git worktree
- **Scalar Metric** — health score 0-100, deterministic, reproducible
- **Time-boxed Cycle** — each experiment runs, proves itself, or gets reverted

---

## Architecture

### The Karpathy Loop (Core Engine — Working Now)

```
    ┌──────────┐
    │ OBSERVE  │◄──────────────────────────────┐
    │ metrics  │                               │
    └────┬─────┘                               │
         │                                     │
    ┌────▼──────────┐                          │
    │  HYPOTHESIZE  │                          │
    │  ┌──────────┐ │                          │
    │  │ Rules    │ │  Mode 0: deterministic   │
    │  │ Ollama   │ │  Mode 1: local LLM       │
    │  │ OpenClaw │ │  Mode 2: agent bridge    │
    │  └──────────┘ │                          │
    └────┬──────────┘                          │
         │                                     │
    ┌────▼──────────┐                          │
    │  EXPERIMENT   │                          │
    │  git worktree │  isolated branch         │
    │  apply patch  │  run tests               │
    └────┬──────────┘                          │
         │                                     │
    ┌────▼──────────┐    score improved        │
    │   EVALUATE    │────& tests pass──────────┘
    │  compare      │         │
    │  scores       │    score dropped
    └───────────────┘    or tests fail
                              │
                         ┌────▼────┐
                         │ REVERT  │
                         └─────────┘
```

### LLM Modes — All Free

| Mode | Engine | How it works | Cost |
|------|--------|-------------|------|
| **deterministic** | `RuleBasedEngine` | 4 built-in rules (console.log, empty catch, TODO, magic numbers) | $0, no internet |
| **ollama** | `OllamaEngine` | Local LLM analyzes code, generates project-specific hypotheses | $0, local GPU |
| **openclaw** | `OpenClawEngine` | OpenClaw coding-agent skill → Ollama backend | $0, local GPU |
| **auto** (default) | auto-detect | Checks if Ollama is running → uses it, otherwise falls back to deterministic | $0 |

### Full System (Roadmap)

```
┌─────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR                         │
│   task select → prioritize → assign worker → dispatch   │
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

| Layer | Responsibility | Status |
|-------|---------------|--------|
| **Karpathy Loop** | observe → hypothesize → experiment → evaluate | **Working** |
| **Core Contracts** | Pure domain types, scoring model, patch schema, command policy | **Working** |
| **Doctor Engine** | Local examination runtime with built-in and external framework experts | **Working** |
| **Orchestrator** | Local SQLite daemon, repo registry, queue, and worker dispatch | **Working** |
| **Worker** | Single repo / single branch / single worktree review-first execution | **Working** |
| **LLM Providers** | Null + Ollama providers with external plugin loading | **Working** |
| **Review Gate** | Diff + build + test review checks with plugin-backed policy checks | **Working** |

---

## Doctor Engine (Roadmap)

Every project gets examined like a patient:

```
1. TRIAGE       → What kind of project? Any emergencies?
2. VITALS       → Numerical health metrics
3. HISTORY      → Git history, hotspot analysis
4. EXAMINATION  → Framework-specific expert checks
5. LAB          → Static analysis, complexity, dependency graph
6. DIAGNOSIS    → Derive conditions from findings
7. TREATMENT    → Prioritized prescription + ADR generation
8. FOLLOW-UP    → Did the treatment work?
```

Framework experts (plugin system): Next.js, Supabase, Prisma, Drizzle,
Express/Hono/Fastify, Django, Docker, Go, Rust, Rails, Laravel, Flutter.

---

## LLM Provider

```
mode: "auto"  →  Ollama running?  → use local LLM (FREE)
                  No Ollama?       → deterministic mode (FREE, no LLM)
                  API key set?     → optional cloud upgrade
```

**Everything works without an LLM.** Static analysis, metrics, health scoring — all deterministic.
LLM enhances hypothesis generation with project-specific suggestions.

```bash
# Recommended: Ollama (local, free, private)
ollama pull qwen3-coder:30b      # Best local coding model (Apache 2.0)
ollama pull nomic-embed-text     # Embeddings (optional)

# Optional: Cloud API (not required)
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

---

## Getting Started

```bash
git clone https://github.com/canfamily/coco
cd coco
pnpm install
```

### OMP long-running coding harness

The repository includes a project-scoped OMP configuration with OpenRouter model routing,
fallbacks, isolated subagents, checkpoints, context compaction, and Chromium automation.

```bash
# Interactive terminal session (write/exec actions ask for approval)
pnpm harness

# Unattended plan -> implement -> test loop, capped at 8 hours
pnpm harness:long -- "Implement the next PLAN.md milestone and verify it in the browser"

# Resume a saved harness session
pnpm harness:resume

# Check the local harness installation and model catalog
pnpm harness:doctor
```

Set `OPENROUTER_API_KEY` in the shell or the repository `.env`. OMP sessions and screenshots are
stored under `.runtime/omp/`. The long-running command prevents macOS idle sleep, but never pushes,
merges, publishes, or deploys unless explicitly instructed.

### Local Maintainer Runtime

```bash
cp .env.example .env
# paste your OPENROUTER_API_KEY into .env if you want remote coding models

# Register a repo
pnpm --filter @coco/cli exec coco repo add .

# Run a doctor exam directly or through the local daemon
pnpm --filter @coco/cli exec coco doctor run . --json

# Run one review-first loop experiment
pnpm --filter @coco/cli exec coco loop run . --rounds 1 --provider null --json

# Run one remote OpenRouter/OpenClaw experiment with StepFun Step 3.5 Flash Free
pnpm --filter @coco/cli exec coco loop run . \
  --rounds 1 \
  --provider openclaw \
  --model stepfun/step-3.5-flash:free \
  --json

# Review the current repo
pnpm --filter @coco/cli exec coco review run . --json

# Start the loopback-only daemon
pnpm --filter @coco/cli exec coco daemon start --parallel 4

# Queue multiple repos for unattended background work
pnpm --filter @coco/cli exec coco loop fanout ../repo-a ../repo-b ../repo-c \
  --provider openclaw \
  --model stepfun/step-3.5-flash:free \
  --json

# Inspect daemon jobs
pnpm --filter @coco/cli exec coco jobs list --json
```

### Theia IDE (First Vertical Slice)

`coco` now includes the first Theia-facing packages for the medium-term OSS IDE direction:

- `@coco/theia` — shared Theia extension package with:
  - `OpenClaw Chat` view
  - `Task Monitor` view
  - shared workbench blueprint helpers
- `@coco/theia-browser-app` — browser app manifest that can host the Coco Theia extension

Current goal of this slice:
- reuse the shared OpenClaw supervisor
- surface live `/tasks`, `/workers`, and `/sessions` in a proper IDE shell
- keep chat, monitoring, and code editing in one open-source workbench

Useful commands:

```bash
# Build the shared Theia extension package
pnpm --filter @coco/theia build

# Bundle the browser app shell
pnpm theia:bundle

# Start Coco IDE on http://127.0.0.1:3001
pnpm theia:start
```

This is the first IDE slice, not the final product. It gives us the shared extension surface
for chat-first orchestration and monitoring; host-native execution, richer diff/review UX, and
desktop packaging come next.

### Unattended macOS Background Run

If you want `coco` to keep working while you are away from the keyboard, install the daemon as a `launchd` agent on macOS:

```bash
cp .env.example .env
# paste your OPENROUTER_API_KEY into .env

pnpm --filter @coco/cli exec coco daemon install-launchd --parallel 4
launchctl list | rg coco
```

You can inspect the generated plist before installing it:

```bash
pnpm --filter @coco/cli exec coco daemon print-launchd --parallel 4
```

Notes:
- The daemon reads `.env` automatically from the working directory, or from `COCO_ENV_FILE` if set.
- Local background execution still stops if the machine goes to sleep.
- For true 24/7 unattended coding, run the daemon on an always-on Mac mini, server, or cloud VM.

### Telegram Bot Control

You can drive `coco` remotely from your phone through Telegram. The bot talks to the local daemon and keeps a lightweight per-chat session with:

- active repo
- default provider
- default model

Environment:

```bash
cp .env.example .env
# paste TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY into .env
```

Run locally:

```bash
pnpm --filter @coco/telegram build
node packages/telegram/dist/index.js
```

Key Telegram commands:

```text
/help
/repos
/repoadd /absolute/path/to/repo
/use repo-name-or-id
/provider openclaw
/model stepfun/step-3.5-flash:free
/repoadd /host-home/Desktop/my-app
postgres-dev containerini restart et
/doctor
/loop
/fanout repo-a repo-b repo-c
/jobs
/job <job-id>
/session
```

Docker profile:

```bash
docker compose --profile bot up -d orchestrator telegram-bot
```

Recommended:
- set `TELEGRAM_ALLOWED_CHAT_IDS` to your own chat id(s)
- keep repos registered on the host first if you prefer not to send absolute paths through Telegram

### Karpathy Loop (Working Now)

```bash
# Preview what coco would do (no changes)
pnpm loop -- . --dry-run

# Run 5 improvement rounds (deterministic, no LLM)
pnpm loop -- . --mode deterministic

# Run with local LLM (requires Ollama)
pnpm loop -- . --mode ollama --model qwen3-coder:30b

# Auto-detect best available mode
pnpm loop -- .

# Full options
pnpm loop -- . --rounds 10 --mode ollama --model deepseek-r1:14b --verbose
```

### Example Output

```
  COCO Karpathy Loop v0.1
  Target: /path/to/your/project
  LLM: qwen3-coder:30b (Ollama, local, FREE)
  ━━━━━━━━━━━━━━━━━━━━━━━━

  [observe] Initial health score: 78/100
            security:        ████████████████████ 100
            maintainability: ██████████░░░░░░░░░░ 32
            reliability:     ████████████████████ 100
            size:            ██████████████████░░ 90

  [round 1/3]
    [hypothesize] Analyzing karpathy-loop.ts with LLM...
    [hypothesize] "Extract ANSI color codes into a reusable object" → expected +8 maintainability
    [experiment]  worktree: ../coco-exp-a3f2 | branch: experiment/a3f2
    [patch]       Modified 1 file (18 lines changed, within safety limits)
    [test]        npm test → PASS
    [re-audit]    New score: 82/100 (+4)
    [evaluate]    ✓ VALIDATED — committed as a3f2e91

  ━━━━━━━━━━━━━━━━━━━━━━━━
  SUMMARY
    Rounds:     3
    Validated:  2 (67%)
    Reverted:   1
    Score:      78 → 85 (+7)
    Commits:    a3f2e91, b7c1d04
```

### Docker (Full Stack — Roadmap)

```bash
cp .env.example .env
# edit .env and set a local POSTGRES_PASSWORD before first boot
docker compose up -d
```

## Plugin Runtime

`coco` now supports three plugin kinds:

- `framework-expert`
- `review-check`
- `llm-provider`

Built-in plugins are always loaded. External plugins can be loaded from one or more files or directories with `COCO_PLUGIN_PATHS`.

```bash
# Load all plugin modules from the example directory
export COCO_PLUGIN_PATHS=./examples/plugins

# Inspect what coco sees
pnpm --filter @coco/cli exec coco plugins list --json
pnpm --filter @coco/cli exec coco plugins inspect example-doctor-repo-note --json

# External plugins now participate in runtime flows
pnpm --filter @coco/cli exec coco doctor run . --json
pnpm --filter @coco/cli exec coco review run . --json
```

Example plugin modules live in [examples/plugins/doctor-repo-note.mjs](/Users/canfamily/Desktop/coco/examples/plugins/doctor-repo-note.mjs), [examples/plugins/review-policy-note.mjs](/Users/canfamily/Desktop/coco/examples/plugins/review-policy-note.mjs), and [examples/plugins/llm-mock-provider.mjs](/Users/canfamily/Desktop/coco/examples/plugins/llm-mock-provider.mjs).

---

## Project Structure

```
coco/
  packages/
    loop/           Karpathy Loop engine (working)
    core/           Pure contracts, scoring, patch, and policy types
    llm/            Provider registry and adapters (scaffolded)
    doctor/         Doctor engine and framework experts
    orchestrator/   Local daemon, repo registry, and job queue
    worker/         Single-project review-first coding worker
    review/         Lint, test, diff, and plugin-backed review gate
    cli/            CLI commands and plugin inspection
  examples/
    plugins/        External plugin examples
  docker/
    compose.yml
    Dockerfile.*
    init.sql
```

---

## Contributing

1. Fork → feature branch → small patches
2. Every patch must pass tests
3. No merge without PR summary
4. No merge without review

```bash
git worktree add ../coco-feature-x feature/x
cd ../coco-feature-x
# ... work ...
pnpm test
gh pr create
```

---

## License

MIT — Free and open source. In the spirit of Linux, Git, and every tool that
made software engineering possible.

---

*coco — named after my cat, the soul of the system.*
