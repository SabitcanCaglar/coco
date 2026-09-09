# Coco agent operating contract

## Mission

Build Coco as a local-first, deterministic-first code-health and autonomous experimentation system. Preserve the review-first architecture in `PLAN.md`: evidence, isolation, deterministic gates, and reproducible artifacts come before distributed complexity.

## Working protocol

1. Inspect the repository, current git state, `PLAN.md`, and relevant tests before changing code.
2. Turn non-trivial work into a todo list with explicit acceptance criteria.
3. Keep changes scoped. Never overwrite unrelated dirty files or generated Theia output.
4. Use isolated subagents for independent research/review tasks. Do not let multiple agents edit the same files concurrently.
5. Prefer the cheapest capable model. Escalate to the `slow` role only after concrete failure, ambiguity, or a high-risk architectural decision.
6. After each meaningful slice, run the narrowest relevant checks. Before completion, run the full quality gate.
7. For UI work, launch the app and use the browser tool. Verify behavior, console errors, and at least one representative interaction; save screenshots under `.runtime/omp/screenshots` when they add evidence.
8. Do not claim completion while tests, typecheck, lint, browser verification, or stated acceptance criteria remain unresolved.
9. At context pressure, checkpoint, compact, and continue from the persisted todo state. Do not restart completed work.
10. Report changed files, commands run, remaining risks, and any intentionally deferred work.

## Quality gate

Run these from the repository root unless the task is explicitly narrower:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm build
```

For Theia/browser changes also run the relevant runtime smoke command and exercise the affected UI in Chromium.

## Safety boundaries

- Never expose `.env` values or credentials in output.
- Never merge, push, publish, deploy, or delete material data unless the user explicitly requests it.
- Keep autonomous edits inside this repository or an OMP-managed isolated worktree.
- Treat generated files under `packages/theia-browser-app/lib` and `src-gen` as build output; change their sources instead.
