# Architecture — Multi-agent PR Review

> The leitmotif: a multi-agent review modelled as a **durable state machine**, so
> it survives a process restart and an arbitrarily long human-in-the-loop pause
> and resumes from its checkpoint. Everything else (parallel agents, dedup,
> publish) hangs off that.

---

## Stack

| Layer | Technology | Notes |
| --- | --- | --- |
| Framework | Next.js 16 App Router | route handlers + a single client page; `runtime = 'nodejs'` |
| Agents | Vercel AI SDK `generateObject` | one structured call per specialist, Zod-validated findings |
| Model routing | Vercel AI Gateway | `gateway('anthropic/claude-sonnet-4-6')` etc. — one key, no per-provider SDKs |
| Durable state | Supabase Postgres | `runs` + `findings`; accessed server-side via `postgres.js` |
| Source | `@octokit/rest` | read-only PR fetch; opt-in `issues.createComment` for real posting |
| Validation | Zod 4 | `Finding` / `SpecialistOutput` schemas |
| Observability | `@langfuse/otel` + `@langfuse/tracing` | OTEL spans, specialists grouped per run via `propagateAttributes` |

**Intentionally not used:** an agent framework (Mastra / LangGraph), a workflow
engine (Temporal / Inngest), a vector DB, and a message queue — see DECISIONS.

---

## Data model — the state machine

```sql
runs(
  id uuid pk, pr_url, owner, repo, number, title, model,
  status text,   -- reviewing → awaiting_approval → publishing → done | failed
  meta jsonb,    -- meta.completed: which specialists have finished
  error, created_at, updated_at
)
findings(
  id uuid pk, run_id fk, specialist, file, line, severity,
  title, rationale, suggestion,
  dedup_key,                       -- UNIQUE(run_id, dedup_key): idempotent inserts
  decision text default 'pending', -- pending | approved | rejected  (HITL)
  published boolean default false
)
```

Both tables have **RLS enabled with no policies** — all access is server-side over
the superuser `DATABASE_URL`, so nothing is exposed through Supabase's anon
PostgREST API.

```
        ┌───────────┐  all specialists done   ┌───────────────────┐
  ──────▶ reviewing  ├────────────────────────▶ awaiting_approval  │
        └─────┬─────┘                          └─────────┬─────────┘
              │ crash/restart                            │ human approves
              │ resumeRun() re-drives                    ▼
              └──────────────────────────────────▶ publishing ──▶ done
```

## Durable, resumable orchestration (`lib/orchestrator.ts`)

- **`reviewRun`** sets `reviewing`, fetches the diff, and runs only the
  specialists *not* already in `meta.completed`, in parallel. Each one persists
  its findings (`INSERT … ON CONFLICT (run_id, dedup_key) DO NOTHING`) and is then
  added to `meta.completed`. When all four are done → `awaiting_approval`. Re-entry
  is a no-op past that state. So a crash mid-review loses nothing: completed
  specialists are skipped and idempotent inserts dedupe the rest.
- **`publishRun`** publishes only `approved && !published` findings and flips
  `published`, so re-running never double-posts.
- **`resumeRun`** inspects `status` and re-drives the right step — the recovery
  entry point after a restart.

The "pause for a human" is just the `awaiting_approval` state sitting in Postgres;
nothing is held in memory, so the wait can be arbitrarily long.

## Specialists (`lib/specialists.ts`)

Four `generateObject` calls, each with a lens-specific system prompt over the same
diff, returning `SpecialistOutput` (an array of `Finding`). They run concurrently
and never see each other's output. Each carries `experimental_telemetry` so it
shows up as a span; the orchestrator wraps the `Promise.all` in
`propagateAttributes({ sessionId, tags })` so all four group under one Langfuse
trace per run.

Dedup happens in JS via `dedupKey(file, line, normalized-title)` and is enforced
at the DB by the unique index — so two specialists flagging the same line collapse
to one finding.

## API surface (`app/api/`)

| Route | Purpose |
| --- | --- |
| `POST /api/review` | create the run, return `runId`, drive the review in `after()` |
| `GET /api/runs` · `GET /api/runs/[id]` | list / fetch run + findings |
| `POST /api/runs/[id]/decision` | set one finding's decision, or `{ all }` |
| `POST /api/runs/[id]/publish` | publish approved findings |
| `POST /api/runs/[id]/resume` | re-drive an interrupted run from its checkpoint |

`/api/review` returns the `runId` immediately and runs the slow review after the
response (`after()`), so the UI polls. If that invocation is cut short, the run
stays `reviewing` and `/resume` finishes it — the durable design degrades
gracefully on serverless.

## Observability

`instrumentation.ts` registers a `NodeTracerProvider` + `LangfuseSpanProcessor`
(Node runtime only). The review/resume routes `forceFlush()` after the background
work so spans aren't lost when the function freezes. No keys → spans are emitted
but not exported, and the app behaves identically.

## Repo structure

```
app/
  page.tsx                 # client review flow (poll → findings → approve → publish)
  api/review/route.ts      # POST: create + drive review
  api/runs/[id]/...        # GET run, decision, publish, resume
lib/
  schemas.ts               # Zod Finding/SpecialistOutput + dedupKey + Run types
  models.ts                # gateway model routing
  github.ts                # PR fetch / diff render / opt-in comment post
  specialists.ts           # the 4 generateObject reviewers
  orchestrator.ts          # the durable state machine
db/
  client.ts                # postgres.js
  runs.ts                  # runs/findings data access
supabase/migrations/       # runs + findings schema
evals/                     # planted-bug fixtures, scorer, harness
scripts/review-cli.ts      # end-to-end CLI
instrumentation.ts         # Langfuse OTEL bootstrap
```
