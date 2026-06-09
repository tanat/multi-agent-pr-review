# Multi-agent PR Review

> Paste a GitHub PR URL. Four specialist agents — **security, correctness, tests,
> style** — review the diff **in parallel**, an orchestrator dedups and merges
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

| Metric | Result (sonnet) |
| --- | --- |
| Recall (planted bugs caught) | **1.00** (8/8) |
| Precision | 0.19 (heavy over-flagging) |
| Parallelism speedup | **2.83×** (137s of agent work in 48s wall) |

Low precision is expected — and it's *why the product has a human approval step*.
The models also flag real, un-planted issues, so precision is a lower bound. Full
methodology and honesty notes in [evals/README.md](./evals/README.md).

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
