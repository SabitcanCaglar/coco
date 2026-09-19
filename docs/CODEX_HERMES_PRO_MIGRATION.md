# Codex Pro Windows Migration Plan

Status: **PLAN / NO-GO**
Owner: Codex
Target: Codex App UI as the control plane, Windows as the always-on execution host, the ChatGPT mobile app as the remote interface, and Hermes as an optional supervised persistence layer only if native Remote proves insufficient.

## 1. Target outcome

The user works from Codex App UI on Mac or from Remote in the ChatGPT mobile app. Substantial work executes on an always-on Windows machine. Codex owns planning, risk decisions, review, and final acceptance. Coco's Pi/OMP harness owns isolated coding loops, deterministic gates, browser checks, and checkpoints. Docker Desktop provides project services and reproducible dependencies; it is not the device-sync mechanism. Hermes and Telegram remain optional and are introduced only if Codex Remote cannot meet a measured persistence or messaging requirement.

The migration must not create a second OpenAI API bill by accident. Codex App and Codex CLI must use **Sign in with ChatGPT** on the Pro 5x account. The **API key** option is pay-as-you-go and remains disabled unless the user later authorizes separate API spending. If Hermes is added later, its `openai-codex` OAuth route remains experimental until a bounded canary proves account eligibility, expected plan usage, acceptable terms, and zero API charges.

## 2. Non-negotiable architecture

```text
Codex App UI (Mac / Windows) + ChatGPT Remote (phone)
        |
        v
Always-on Windows host
        |
        +-- canonical repository checkout (native or WSL2, selected by qualification)
        +-- Docker Desktop services
        +-- Codex execution sessions
        +-- Pi/OMP isolated worktrees and quality gates
        +-- optional Hermes gateway only after native Remote qualification
        |
        v
Git branch / diff / tests / browser evidence
        |
        v
Codex final acceptance
```

Responsibilities:

- **Codex App**: architecture, task decomposition, scope, model choice, risk, review, final acceptance.
- **Windows host**: stable execution environment, ChatGPT desktop host, and repository storage.
- **ChatGPT mobile Remote**: start, guide, approve, and review Codex tasks from the phone.
- **Docker Desktop**: databases, browsers/services where appropriate, and reproducible project dependencies. It does not synchronize chats, repositories, or credentials.
- **Hermes, if later enabled**: persistence, supplemental messaging, resumable supervision, and status reporting. It does not independently merge, push, deploy, or approve its own output.
- **Pi/OMP**: worktree isolation, implementation loop, deterministic checks, browser verification, persisted evidence.
- **Git**: transfer boundary between machines. No absolute Mac or Windows paths may enter committed configuration.

## 3. Current readiness audit

Observed on 2026-09-18:

| Area | Current state | Decision |
|---|---|---|
| Codex App / CLI | Installed and active | Pass |
| Hermes | v0.21.1, update available | Not a cutover blocker while excluded from the critical path |
| Hermes gateway | Running under launchd | Pass on Mac; Windows service not verified |
| Hermes main provider | OpenRouter, Qwen Coder | Preserve but keep outside the primary route |
| OpenAI Codex OAuth in Hermes | Not configured | Required only if Hermes is later activated |
| Telegram | Configured and running | Optional; not required for mobile access |
| ChatGPT mobile Remote | Not yet paired to Windows | Blocker |
| Codex App authentication | Must be ChatGPT subscription login, not API key | Blocker until verified on Windows |
| Coco contract | Codex control plane, deterministic gates, worktree isolation defined | Pass |
| Windows/WSL2 environment | Not yet inspected | Blocker |
| Browser dependency audit | High/moderate npm advisories reported | Review and remediate before unattended execution |

Current decision: **NO-GO**. The system is usable today, but it is not ready for an unattended Pro-backed migration.

## 4. Migration phases

### Phase A — Freeze and recovery baseline

1. Pause new Hermes dispatch without terminating the gateway abruptly.
2. Record active sessions, gateway status, version, project mappings, and scheduled jobs.
3. Create an encrypted or permission-restricted Hermes backup. Never print credentials.
4. Preserve the current OpenRouter configuration as a disabled rollback profile.
5. Capture current Codex usage percentages and reset times.

Acceptance:

- Backup restores into a temporary Hermes home.
- Existing Telegram configuration can be identified without exposing its token.
- Rollback profile does not auto-bill OpenRouter.

### Phase B — Windows execution host

1. Install the latest supported ChatGPT desktop app on Windows and sign in to the same ChatGPT Pro workspace used on mobile.
2. Install WSL2 with a supported Ubuntu release and Docker Desktop with its WSL2 backend.
3. Qualify two checkout modes: a native Windows checkout for direct desktop access, and a WSL2 checkout for Linux-compatible tooling. Select exactly one canonical checkout; do not let both become active writers.
4. Install Git, Node, pnpm, Python, uv, ripgrep, Docker integration, and Playwright/Chromium dependencies in the selected execution environment.
5. Clone the repository normally. Do not copy `node_modules`, virtual environments, `.runtime`, credentials, or generated Theia output from the Mac.
6. In Windows ChatGPT desktop, enable **Control this PC**. Pair the phone by QR code while both devices use the same account and workspace. Keep the host powered, online, and awake. Desktop-control tasks require an unlocked session.
7. If the canonical checkout is WSL2, configure an explicit SSH bridge from the Windows app to WSL2 and prove the login shell lands at the Linux repository path. Expose no App Server port publicly.
8. Run repository bootstrap and narrow smoke checks before any autonomous work.

#### Headless worker mode

Windows is an execution host, not an interactive desktop. Codex App may remain available for
Remote control, but builds, commands, and browser tests run inside WSL2 or project containers and
must not open visible application windows. UI projects use headless Chromium. Every browser run
persists screenshots plus Playwright trace/video when supported, console errors, the tested URL,
and the final exit code under the project's ignored runtime artifact directory.

The checked-in OMP browser policy already sets `headless: true` and writes screenshots to
`.runtime/omp/screenshots`. Each managed project must supply its own deterministic start command,
health URL, and browser-test command; Coco invokes those commands in that project's isolated
worktree. Interactive headed mode is diagnostic-only and requires an explicit request.

After configuring `coco.projects.json`, the Windows/WSL worker is checked without opening a UI:

```bash
pnpm host:doctor
```

Acceptance:

- A fresh clone resolves dependencies without machine-specific path edits.
- `git status` remains clean after bootstrap, excluding documented runtime artifacts.
- Codex App, Codex CLI, and Pi/OMP resolve the same canonical checkout and commit. Native Windows and WSL configuration, authentication, and history are not assumed to be shared.
- ChatGPT mobile Remote can start a read-only task, display terminal output, receive an approval request, and show the final diff/test result.
- If WSL2 wins qualification, the SSH login shell lands in WSL2 at the Linux repository path and returns a read-only command result to Codex App.
- Restarting Windows and WSL restores the approved services without duplicate gateway processes.
- A representative UI test completes while Windows has no browser window open; its screenshot,
  trace or video, console log, and exit result can be reviewed remotely.

### Phase C — Subscription authentication and mobile Remote

1. Upgrade the same ChatGPT account used by Codex App to the selected Pro tier.
2. Confirm that the purchased tier is **Pro 5x**.
3. On Windows ChatGPT desktop and Codex CLI, select **Sign in with ChatGPT**. Do not choose the API-key path.
4. Confirm the same ChatGPT account and workspace on Windows and mobile, then pair Remote.
5. Inventory the sanitized Windows, WSL2, Docker, and service environments. Ensure no inherited `OPENAI_API_KEY` can silently change the authentication path.
6. Run one small, bounded, read-only task from Windows and one from mobile Remote. Compare the Codex usage dashboard and OpenAI Platform billing before and after.

Acceptance:

- Codex App and CLI visibly report ChatGPT subscription authentication.
- Both tasks succeed without an OpenAI API charge.
- Plan usage changes consistently with the Pro 5x dashboard.
- Run evidence records the effective provider, model, base URL class, and each auxiliary route without recording credentials.
- If subscription accounting cannot be verified, migration stops.

### Phase C2 — Optional Hermes qualification

Run this phase only when native Codex Remote fails a measured requirement such as Telegram delivery, scheduler integration, or cross-session supervision.

1. Back up and update Hermes to a reviewed, pinned revision.
2. Disable Telegram on the Mac before enabling a Windows gateway.
3. Test Hermes `openai-codex` OAuth with a strict usage and billing canary.
4. Audit main and auxiliary routes to prevent OpenRouter or API-key fallback.
5. Enable checkpoint, loop-stop, idempotency, and usage controls before any long run.

Failure of this optional phase does not block native Codex Remote cutover; Hermes remains disabled.

### Phase D — Model and workload policy

Model IDs must be selected from the live catalog after OAuth. Intended roles:

- **Luna-class**: routing, repository indexing, log triage, extraction, status summaries, and narrowly scoped edits.
- **Terra-class**: ordinary production changes, tests, documentation, and bounded multi-file work.
- **Sol-class**: ambiguous architecture, broad refactors, security-sensitive decisions, repeated quality-gate failures, and final high-risk review.
- **Codex App interactive session**: final scope approval and acceptance regardless of worker model.

Promotion is evidence based:

1. Start at the cheapest role that matches the task.
2. Promote after two materially distinct failed attempts, a context limitation, a safety conflict, or a review-gate failure.
3. Never promote merely because a task is long.
4. Never let a fallback silently switch to a separately billed provider.

Acceptance:

- Every run artifact records the selected provider/model and promotion reason.
- Unsupported model names fail closed.
- OpenRouter and other paid fallbacks remain disabled by default.

### Phase E — Long-running safety controls

Required policy changes for Codex/Pi/OMP:

- Require a persisted checkpoint before context compression.
- Enable exact-failure, repeated-tool-failure, and no-progress hard stops.
- Replace the global 500-turn ceiling with bounded job classes.
- Reduce recursive delegation from the current 250 iterations to a small reviewed limit.
- Require worktrees for write-capable repository tasks.
- Require a clean baseline or explicit dirty-tree acknowledgement.
- Disallow automatic push, merge, deploy, destructive deletion, and secret display.
- Add a global pause command that prevents new work while preserving evidence.
- Enforce a task ID and idempotency key at every Codex-to-runner handoff.
- Persist worktree owner, lease, active writer, cancellation state, and last accepted checkpoint.
- Permit only one active writer per worktree and only one execution per idempotency key.
- Bound wall-clock time, concurrent jobs, subprocesses, context growth, and daily/weekly plan usage in addition to turns.
- Pause before exhausting the plan reset window rather than allowing a fallback to another billable provider.

If optional Hermes/Telegram is later enabled, keep Telegram commands scoped to status, pause/resume, approved task submission, and review notifications. Apply the same controls to the Codex-to-Hermes handoff before enabling its gateway.

Proposed job classes:

| Class | Purpose | Turn ceiling | Required gates |
|---|---|---:|---|
| Inspect | Read-only diagnosis | 30 | evidence report |
| Focused edit | Small bounded change | 60 | narrow tests + diff review |
| Feature | Multi-file production change | 120 | typecheck, tests, lint, build, review |
| Long goal | Multi-stage complex work | 200 with checkpoints | phase acceptance after each slice |

The exact ceilings may be adjusted after the first week of measured runs. No job receives an unbounded loop.

### Phase F — Portable repository contract

Repository-owned instructions must work on Mac and WSL2:

- Keep `AGENTS.md`, prompts, acceptance criteria, and scripts relative to the repository root.
- Detect platform capabilities instead of hardcoding `/Users/...`, drive letters, or shell-specific paths.
- Store runtime state under ignored `.runtime/` or an explicitly configured Coco home.
- Keep credentials in the host credential store or permission-restricted user configuration, never in Git.
- Add a WSL bootstrap script and a read-only environment verification command.
- Pin and verify Node, pnpm, Python, Hermes, browser, and required system dependency versions.
- Review Hermes release notes, schema migrations, source, dependency lock, and exact target commit before upgrading; retain a tested rollback to v0.21.1.
- Keep a clean-clone manifest covering Git LFS/submodules, ignored runtime data, Hermes home, Telegram state, browser binaries, and Docker volumes.
- Preserve LF line endings for shell scripts and executable bits through Git.
- Document browser behavior on headless WSL and the optional visible Windows browser path.

Acceptance:

- The same checked-in task prompt runs on Mac and WSL2 without content changes.
- A test task produces equivalent artifact structure on both systems.
- A brand-new WSL user passes bootstrap and doctor checks without inherited host state.
- Normalized paths, line endings, executable bits, lockfiles, tool versions, artifact schemas, and representative test/build/browser results agree across hosts.
- No committed file contains a user-specific absolute path or credential.

#### Multi-project registry

Each machine keeps its own ignored `coco.projects.json`, copied from the checked-in
`coco.projects.example.json`. The manifest uses stable human-readable slugs but stores
machine-local paths; database UUIDs are implementation details and are regenerated on a new host.

```bash
cp coco.projects.example.json coco.projects.json
# Edit paths for the canonical WSL checkout, then:
pnpm --filter @coco/cli exec coco repos sync coco.projects.json
pnpm --filter @coco/cli exec coco repos --json
pnpm --filter @coco/cli exec coco session create "Cross-project task" \
  --repo-root ../project-a --repo-root ../project-b --json
```

The Windows qualification begins with one repository, expands to three repositories, and includes
two repositories running concurrently in separate worktrees. Each write-capable run must record and
verify the selected repository root, branch, and HEAD before editing. Git—not Docker—is the transfer
boundary between machines.

### Phase G — Quality and endurance qualification

Run the following qualification suite before approval:

1. **Read-only audit**: inspect a repository and produce evidence without changing files.
2. **Focused edit**: implement a small change in an isolated worktree and pass narrow tests.
3. **Complex task**: complete a multi-file change with a persisted plan, checkpoint, tests, lint, build, and review.
4. **Browser task**: launch the relevant UI, verify a representative interaction, console errors, and screenshot evidence.
5. **Interruption test**: stop and resume a task from its checkpoint without repeating completed work.
6. **Failure test**: force a repeated failing command and verify the loop stops instead of burning quota.
7. **Permission test**: verify push, merge, deploy, secret output, and destructive actions require explicit authority.
8. **Restart test**: reboot the Windows host and verify exactly one controllable Codex host, correct project paths, and resumable state. Verify one gateway only if optional Hermes is enabled.
9. **Power-loss test**: interrupt an active write task and verify one-time recovery without duplicate commits, tool actions, or concurrent writers.
10. **OAuth recovery test**: reproduce stale/expired credential handling, reauthenticate once, and verify no persistent 429 replay loop.
11. **Usage test**: compare plan consumption by job class and model role within a predeclared qualification budget.
12. **Headless browser test**: require Chromium on WSL to pass a real interaction and console-error check.
    Confirm that no visible Windows process or focus-stealing window is created and retain the
    screenshot/trace evidence in the task artifacts.
13. **Billing-negative test**: exercise every main and auxiliary model route and confirm no API/OpenRouter charge.

For Coco repository changes, the final gate remains:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

### Phase H — Controlled cutover

1. Keep the existing Mac environment recoverable for 7 days.
2. Make Windows ChatGPT desktop the sole primary Remote host for this project during qualification. If Hermes is enabled later, allow only one Telegram gateway.
3. Start with one repository, qualify three registered repositories, then enable bounded parallel
   work across distinct repositories. Keep one active writer per repository worktree.
4. Review usage after 24 hours, 72 hours, and 7 days.
5. Expand concurrency only after clean evidence from the initial runs.

## 5. Go / no-go criteria

Codex may issue **GO** only when every item below is true:

- [ ] Pro tier and actual multiplier are confirmed in the account.
- [ ] Windows/WSL2 host passes bootstrap and restart tests.
- [ ] Windows Codex App and CLI are authenticated with ChatGPT, not an API key.
- [ ] Pro 5x subscription usage behavior is verified with bounded desktop and mobile tests.
- [ ] ChatGPT mobile Remote is paired and passes start, guide, approve, diff, and notification checks.
- [ ] No separately billed fallback can activate silently.
- [ ] Codex App, CLI, and Pi/OMP use the same canonical checkout.
- [ ] The project manifest registers at least three repositories; explicit focus, concurrent
      cross-repository execution, and wrong-repository rejection are verified.
- [ ] Task IDs, idempotency, leases, and exactly-once recovery are tested.
- [ ] Checkpoints and loop hard stops are enabled and tested.
- [ ] Worktree isolation and repository quality gates pass.
- [ ] Exactly one remote-control path is active; optional Telegram/Hermes cannot duplicate dispatch.
- [ ] Complex-task, interruption, failure, browser, and permission tests pass.
- [ ] Rollback restore is proven.
- [ ] Credential permissions, disk encryption, SSH key policy, firewall, least privilege, log redaction, and token revoke/re-auth are verified.

If any checkbox remains open, the decision stays **NO-GO**.

## 6. Rollback

1. Pause Windows dispatch.
2. Stop the Windows gateway without deleting state.
3. Re-enable the preserved Mac profile or restore the verified backup.
4. Restore OpenRouter only by explicit user decision; never as an implicit fallback.
5. Preserve failed-run artifacts for diagnosis.
6. Revoke the Windows OAuth credential if the host is no longer trusted.

## 7. First-month success metrics

- Percentage of tasks completed without Sol-class escalation.
- Percentage passing all deterministic gates on the first implementation cycle.
- Median plan usage per job class.
- Number of repeated-tool/no-progress stops.
- Human review time per accepted change.
- Resumed tasks that continue without repeating completed work.
- Incidents involving duplicate gateways, wrong repository, or unexpected billing. Target: zero.

The objective is not maximum message volume. The objective is the highest number of accepted, reproducible changes per unit of subscription capacity.

## 8. Authoritative references

- OpenAI Codex pricing and usage limits: https://developers.openai.com/docs/pricing
- OpenAI remote connections: https://developers.openai.com/docs/remote-connections
- Hermes providers and Codex OAuth: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/integrations/providers.md
- Hermes Codex delegation skill: https://hermes-agent.nousresearch.com/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-codex
