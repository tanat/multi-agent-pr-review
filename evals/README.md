# Eval methodology

Adversarial eval: small, realistic PR diffs with **deliberately planted issues**
(`fixtures.ts`). The harness runs the four real specialists against each diff and
scores their findings against the gold set.

## Run

```bash
pnpm eval                 # claude-sonnet-4-6
pnpm eval --model=gpt-4o  # any key in MODEL_IDS
```

Each run appends a row to `results.json`.

## Matching

A finding counts as a true positive when it matches a gold issue on **specialist
+ file + line within ±3** (file-level gold matches any line in the file). Each
gold issue can be matched once; extra findings count against precision.

## Metrics

- **Precision / recall / F1 per specialist**, micro-averaged across fixtures.
- **Overall** precision/recall/F1.
- **Parallelism speedup** = (sum of per-agent durations) / (wall-clock for the
  parallel `Promise.all`). Shows what running the specialists concurrently buys.

## How to read the numbers (honesty notes)

- **Recall is the headline.** It measures whether the planted bugs are caught.
- **Precision is a lower bound, not a verdict.** The diffs are intentionally
  rough, so the models flag *real* issues we never planted — those count as false
  positives here even when they're legitimate. A low precision number is expected
  and is *why the product has a human-in-the-loop approval step*: the reviewer
  filters the over-flagging before anything is published.
- Findings are non-deterministic, so counts vary run to run; the recall and the
  parallelism speedup are the stable signals.
