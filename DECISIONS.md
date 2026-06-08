# Decisions

Four forks where I picked one path over a defensible alternative.
Format: *I chose X over Y because Z, and the cost of Z is W.*

---

## 1. Hand-rolled orchestration on the Vercel AI SDK, not an agent framework

**Picked.** Specialists are plain `generateObject` calls; the orchestration is a
~120-line state machine I own (`lib/orchestrator.ts`). Same stack as the rest of
the portfolio.

**Alternative.** Mastra or LangGraph — both give workflows with built-in
suspend/resume that map onto HITL + durable execution.

**Why.** The whole point of this project is to *show* I understand multi-agent
orchestration and durable execution, not to delegate them to a framework's
`suspend()`. Hand-rolling the state machine makes the mechanics legible: parallel
fan-out is a `Promise.all`, the checkpoint is a Postgres row, resume is a `switch`
on status. It's also the lighter dependency footprint.

**Cost.** I re-implement things a framework gives free — idempotent steps, retry
semantics, the resume entry point. For a single linear pipeline that's a small,
well-contained amount of code; for a graph with branches and many node types, a
framework would start to pay for itself.

---

## 2. A Postgres state machine for durability, not in-memory or a workflow engine

**Picked.** Run state lives in `runs` + `findings`. Each step is idempotent
(`meta.completed`, `ON CONFLICT` inserts, `published` flags), so a run resumes from
its checkpoint after a crash or a multi-hour human pause.

**Alternatives.** (a) Keep the run in memory and finish it within one request.
(b) A durable-workflow engine (Temporal, Inngest).

**Why.** The human approval step can outlive any process — and on serverless it
*will* (functions are stateless and the pause is open-ended). In-memory state
can't survive that. A Postgres state machine is the minimum honest implementation
of "durable", reuses the Supabase stack from project 04, and the idempotency rules
are easy to reason about. An engine like Temporal is the right tool at many
workflows / high throughput, but it's heavy infrastructure to demonstrate one
resumable pipeline.

**Cost.** I hand-write the idempotency (skip completed specialists, dedup inserts,
skip published findings) that an engine would enforce for me, and there's no
automatic retry/backoff — a failed run is re-driven manually via `/resume`.

---

## 3. Output-only publish by default, real PR comments opt-in

**Picked.** Approved findings render to a Markdown comment shown in the UI. Posting
a *real* PR comment requires `PUBLISH_MODE=github` **and** a separate
write-scoped token.

**Alternative.** Post real comments straight away — a flashier end-to-end loop.

**Why.** A reviewer should be able to run the demo against any public PR without it
writing to GitHub, and the safe-by-default, read-only posture matches the rest of
the portfolio. The mutating path still exists to prove the full loop; it's just
gated behind an explicit flag and credential.

**Cost.** The default demo stops one step short of "it commented on the PR" — the
most impressive beat is behind a flag.

---

## 4. Four separate specialists + a merge step, not one mega-prompt

**Picked.** Four independent `generateObject` calls (security / correctness / tests
/ style), merged and deduped by the orchestrator.

**Alternative.** One prompt that asks a single model to do all four reviews and
return everything.

**Why.** Separate agents are the architecture being demonstrated — they run
*concurrently* (measured 2.83× wall-clock speedup), each gets a focused prompt that
keeps it on its lens, and the eval can score precision/recall *per specialist* to
see which lens carries its weight. A single mega-prompt collapses all of that into
one opaque call and tends to under-cover the lenses it's least "interested" in.

**Cost.** 4× the requests (and tokens) per review, plus a dedup step for findings
two specialists both raise. The parallel fan-out hides the latency; the token cost
is the real price, paid for sharper, separately-measurable coverage.
