# Decisions

Six forks where I picked one path over a defensible alternative.
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

**Why.** This entry used to justify itself with a 2.83× wall-clock speedup, and
that number cannot support the claim. It is an arithmetic property of running
four calls concurrently — bounded above by four whatever the lenses find — and it
says nothing about tokens, which is where the fan-out actually costs 4×.

The measurement that does support it is `pnpm eval:ablation`, which drops the
per-specialist partition and asks the marginal question: **which defects go
uncaught if this lens is not there?** Over 16 fixtures and 67 planted defects,
every lens catches something no other lens catches — 3, 4, 6 and 3 respectively.
So none of the four is redundant, and a single mega-prompt would lose real
coverage.

**Cost.** 4× the tokens: $0.73 for the whole corpus at list price, split
17/24/33/25 across security, correctness, tests and style. The margin is thinner
than this entry originally implied — dropping the cheapest-to-lose lens saves a
sixth of the spend and costs three defects out of 67.

Two things the recordings show that this decision did not predict:

- **71% of the output is duplicate work.** 40 of the 56 caught defects were found
  by more than one lens. That is the strongest argument against the fan-out and,
  at the same time, the raw material for a consensus signal the system currently
  throws away (see decision 5).
- **The lenses do not stay in their lanes.** The claim that "a focused prompt
  keeps it on its lens" is not what the data shows: `style` names 35 defects
  across the corpus against 14 filed as style gold, `tests` 39 against 15.


---

## 5. Deterministic term matching in the eval, not a model judge

**Picked.** A finding counts as catching a planted defect when it lands in the
right place *and* contains one of the `signals` phrases written for that defect.
Plain term overlap, no model call.

**Alternative.** An LLM judge reading each finding against each gold entry.

**Why.** A judge reads intent better — that is not in dispute. It also costs a
call per pair, makes the score move between runs on identical input, and, if it
comes from the same family as the reviewers, has errors correlated with the
errors being measured. The deterministic matcher makes a full re-score free,
which is the property that mattered most here: the previous scorer went
unexamined for months precisely because checking it meant paying for a full
sweep.

**Cost.** A finding phrased entirely outside a gold entry's signals scores as a
miss even when it is right, so recall is a slight under-estimate. `nearMisses`
counts findings that landed on a planted defect while describing something else,
so the size of that blind spot is visible rather than assumed.

---

## 6. Consensus between lenses is not built yet, on purpose

**Picked.** The dedup key stays as it is — a storage-level idempotency key with a
unique index behind it — and no consensus signal ships until it is shown to be
worth something.

**Alternative.** Merge findings across lenses now and surface "3 of 4 specialists
agree" in the UI. It is the obvious feature, and the ablation says the raw
material exists: 40 of 56 caught defects were found by more than one lens.

**Why.** All four lenses call the same model through the same shared instruction
block, so their errors are correlated and agreement means less than
independent-voter intuition suggests. The claim worth shipping is not "we merge
duplicates" but "agreement predicts that a human approves the finding", and that
is a measurement nobody has taken. Building the feature first would produce a
confident number with nothing behind it.

**Cost.** The product looks less finished than it could, and duplicate findings
reach the human. If the lift turns out not to be real, the honest outcome is to
publish the null result — which is a better artefact than the feature would have
been.
