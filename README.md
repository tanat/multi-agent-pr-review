# Multi-agent PR Review

**[Live demo →](https://multi-agent-pr-review.vercel.app)**

> Paste a GitHub PR URL. Four specialist agents — **security, correctness, tests,
> style** — review the diff **in parallel**, an orchestrator dedups and stores
> their findings, and **you approve each finding** before anything is published.
> The whole run is a durable state machine: it survives a restart and the
> hours-long human pause, then **resumes from its checkpoint**.

It integrates, in one product, the three patterns that are hardest to demo well
together: **multi-agent orchestration**, **human-in-the-loop**, and **durable /
resumable execution**.

## Wow moment

You paste a PR URL and hit **Review**. Four agents fan out at once; a few seconds
later a ranked list of findings appears — each tagged by specialist and severity,
each with a rationale grounded in the diff and a concrete suggestion. You approve
the ones worth keeping and reject the noise, then **Publish** renders a clean PR
comment (or posts it for real, if you opt in).

On a real PR ([`sindresorhus/p-map#77`](https://github.com/sindresorhus/p-map/pull/77),
a concurrency fix) the correctness agent caught a genuine race condition the diff
re-introduced — the counter is incremented *after* an `await`, so the concurrency
guard lets extra tasks through.

## How it works

```
PR URL
  │ POST /api/review  → create run (status: reviewing), return runId immediately
  ▼
fetch diff (Octokit, read-only)
  │
  ▼  run in parallel (Promise.all), grouped under one Langfuse session
┌───────────┬─────────────┬───────────┬──────────┐
│ security  │ correctness │   tests   │  style   │   ← generateObject, one lens each
└───────────┴─────────────┴───────────┴──────────┘
  │ orchestrator: dedup (file+line+title) + idempotent persist
  ▼
status: awaiting_approval ──── you approve / reject (HITL) ────┐
  ▲                                                            ▼
  └──── resumeRun() re-drives from checkpoint ───────  POST /publish → done
```

The run lives in Postgres (`runs` + `findings`), so every step is idempotent and
the orchestration is **resumable**: if the process dies mid-review, completed
specialists are skipped on resume; if it dies mid-publish, already-published
findings are skipped. That's the point of the project — a review that can wait for
a human for hours and pick up exactly where it left off.

## Eval

Adversarial: PR diffs with **deliberately planted bugs** (`evals/`). The harness
runs the real specialists and scores findings against the gold set.

16 fixtures, 67 planted defects, 2 of them clean diffs with nothing planted.

| Metric | Result (`claude-sonnet-4-6`) |
| --- | --- |
| Recall (planted defects caught) | **77.6%** (52/67), 95% CI [66.3%, 85.9%] |
| Precision | 24.3% — a lower bound |
| Cost of a full sweep | $0.73 at list price |
| Caught by classes the prompt names / does not name | 79.6% / 72.2% |

This table used to read **Recall 1.00 (8/8)**, and that number was the best
evidence in the repo that its own eval was broken. Matching was location only —
same file, within three lines — so a remark about variable naming scored as the
SQL injection planted beside it. The fixtures already described each defect and
nothing read the description. A finding now has to be in the right place *and*
name the defect; `evals/__tests__/score.test.ts` contains the test that made the
old behaviour visible, still named after what it found.

Low precision is expected, and it is *why the product has a human approval step*.
The models also flag real, un-planted issues, so precision is a lower bound — the
one unambiguous noise figure is findings per clean diff, where nothing was
planted at all.

`pnpm eval:ablation` answers the question the per-lens table cannot: **which
defects go uncaught if this lens is not there?** Every lens catches 3-6 defects
no other lens finds, so none is redundant — but 40 of the 56 caught defects were
found by more than one lens, so 71% of what the fan-out produces is duplicate
work. Full methodology in [evals/README.md](./evals/README.md).

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 |
| Agents | Vercel AI SDK `generateObject` (Zod-typed findings), hand-rolled orchestration |
| Models | Claude Sonnet 4.6 / GPT-4o / Gemini 2.5 via the AI Gateway (one key) |
| Durable state | Supabase Postgres (`runs` + `findings`), `postgres.js` server-side |
| Source | GitHub REST via `@octokit/rest` (read-only fetch; opt-in comment posting) |
| Observability | Langfuse + OpenTelemetry (specialists grouped per run) |

## Running locally

```bash
pnpm install
pnpm db:start          # local Supabase (Docker) — Postgres :54322
pnpm db:reset          # apply the runs/findings migration
cp .env.example .env.local   # set AI_GATEWAY_API_KEY + GITHUB_TOKEN (read-only PAT)

pnpm dev               # http://localhost:3000 — paste a PR URL
pnpm review <pr-url>   # same flow from the CLI (review → approve all → publish)
pnpm eval              # adversarial eval over planted-bug fixtures
```

`SUPABASE_URL`/`DATABASE_URL` default to the local stack; `pnpm db:status` prints
them. Langfuse and the real-comment publish path are optional (see `.env.example`).

## Deploy

Same stack in prod: hosted Supabase + Vercel.

```bash
pnpm supabase link --project-ref <ref> && pnpm supabase db push
```

Set `AI_GATEWAY_API_KEY`, `GITHUB_TOKEN`, `DATABASE_URL`, `SUPABASE_URL` on Vercel.
A durable store is required because Vercel functions are stateless and the human
pause outlives any single invocation — local SQLite would not survive it.

## Docs

- [ARCHITECTURE.md](./ARCHITECTURE.md) — state machine, orchestration, observability
- [DECISIONS.md](./DECISIONS.md) — the forks, with rationale and cost
- [evals/README.md](./evals/README.md) — eval methodology
