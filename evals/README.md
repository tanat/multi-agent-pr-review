# Eval methodology

Adversarial eval: small, realistic PR diffs with **deliberately planted
defects** (`fixtures.ts`). The harness runs the four real specialists against
each diff — through `renderDiff`, exactly as the app does — and scores their
findings against the gold set.

```bash
pnpm eval                      # replays from evals/cache if a recording exists
EVAL_VCR=record pnpm eval      # call the models, overwrite the recordings
pnpm eval --model=gpt-4o       # any key in MODEL_IDS
pnpm eval --repeat=3           # k samples per fixture, to see the spread
```

Each run appends a row to `results.json`.

## What counts as a caught defect

A finding has to be **in the right place and about the right defect**:

- the same file, and within ±3 lines of the planted defect (file-level gold
  matches anywhere in the file);
- and it has to name the defect — decided by term overlap against the `signals`
  written for that gold entry, where every word of one signal phrase must
  appear.

The second half is new, and it is why the numbers moved. Matching used to be
location alone, so a remark about variable naming three lines from a planted SQL
injection scored as a caught injection. That is the whole reason the previous
version of this file reported a recall of 1.000 for all four specialists — the
fixtures already described each defect in a `note` field, and nothing read it.

Pairs are assigned best-first rather than in emission order, so findings at
lines [14, 11] against gold at [11, 16] score two matches, not one.

**Why not a model judge.** A judge would read intent better than term overlap.
It also costs a call per pair, makes the score irreproducible run to run, and —
if the judge comes from the same family as the reviewers — has errors that
correlate with the errors being measured. Deterministic matching keeps re-runs
free, which is what makes it possible to change the scorer and see the effect
immediately. The cost is that a finding phrased entirely outside a gold entry's
signals is scored as a miss; `nearMisses` counts those so the size of the
blind spot is visible rather than assumed.

## Metrics

| Metric | What it means |
|---|---|
| **recall** | planted defects the lens caught. The headline, reported with a Wilson 95% interval — 8/8 is not 1.00, it is 1.00 with a lower bound near 0.63 |
| **precision** | a **lower bound**. Findings outside the gold set may be real defects nobody thought to plant |
| **near misses** | findings sitting on a planted defect that describe something else. The difference between a lens that missed the bug and one that looked straight at it and reported something different |
| **findings per clean diff** | the only unambiguous false-positive number. Two fixtures plant nothing at all, so anything reported there is noise the lens generated on its own |
| **primed vs unprimed recall** | recall split by whether the specialist's own prompt names that defect class. A large gap means the lens is matching keywords from its own instructions |
| **parallelism speedup** | how uneven the four latencies were. Bounded above by 4 by construction — it is a property of `Promise.all`, not evidence the fan-out pays for itself |

## The corpus

16 fixtures, 67 planted defects, 2 fixtures with nothing planted.

Three properties it is built to have, each fixing a way the previous
three-fixture set produced unreadable numbers:

1. **Every lens has gold in most fixtures.** Before, two of three fixtures
   planted nothing for `style` and one planted nothing for `tests`. The scorer
   partitions gold per specialist, so a correct style observation in a fixture
   with no style gold counted as a false positive — those precision numbers were
   measuring the gold set's holes.

2. **18 of 67 defects are classes the prompts do not name.** `lib/specialists.ts`
   lists "injection (SQL/command/path), secrets or credentials committed" and the
   old fixtures planted exactly those, so a keyword lookup would have scored
   well. Prototype pollution, DST arithmetic, ReDoS, CSV formula injection,
   unbounded pagination and timing-unsafe comparison are not named anywhere in a
   prompt.

3. **Some diffs are clean.** A corpus where every fixture hides a bug cannot
   measure the cost of a lens that always finds something.

## Latest run — `claude-sonnet-4-6`, 16 fixtures, 67 planted defects

| specialist | gold | found | caught | near | precision | recall |
|---|---|---|---|---|---|---|
| security | 15 | 28 | 11 | 11 | 39.3% | 73.3% |
| correctness | 23 | 50 | 18 | 13 | 36.0% | 78.3% |
| tests | 15 | 76 | 14 | 49 | 18.4% | **93.3%** |
| style | 14 | 60 | 9 | 24 | 15.0% | 64.3% |

**Overall recall 77.6%** (52/67), 95% CI [66.3%, 85.9%]. Overall precision 24.3%,
a lower bound.

Three things worth reading out of that table:

- **The prompts are not just keyword-matching themselves.** Defect classes the
  prompts name: 79.6%. Classes they do not: 72.2%. A 7-point gap on a corpus
  built to expose that gap is a better result than the design expected.
- **`tests` is the loud lens.** Highest recall (93.3%) and the worst signal
  ratio: 76 findings and 49 near misses, plus 1.5 findings per clean diff, on
  diffs that add tests. "There is no test for this" is nearly always available
  to say, and the lens says it.
- **`style` is the weak one on its own gold** (64.3%), which is the one number a
  reader should trust least — style defects are the hardest to write unambiguous
  signals for.

The 2.83× parallelism figure is unchanged from the previous corpus, which is the
point: it is an arithmetic property of running four calls concurrently, not a
measurement of whether four lenses are worth their cost. That question needs a
leave-one-out ablation on cost per caught defect, which is not built yet.

## Recordings

`evals/cache/` holds the raw findings each specialist returned, keyed by model,
prompt version, fixture, specialist, sample index and a hash of the diff.
Everything downstream of the model is recomputed on replay, so a change to
matching, dedup or merging is measured against the same generations rather than
against fresh ones that moved for other reasons.

A full live sweep takes about five minutes and costs real money. The same run
replayed takes 1.9 seconds and produces identical numbers. Recordings are
gitignored; regenerate with `EVAL_VCR=record`.

## Comparing rows in `results.json`

Every row records `matcherVersion`, `corpus` (a hash of the fixtures and gold),
`promptVersion` and `gitSha`. Rows whose `matcherVersion` differs are **not
comparable** — a recall measured by "same file and line" and one measured by
"names the defect" are different quantities wearing the same name. The single
`v1-line-only` row is kept as history, not as a baseline.
