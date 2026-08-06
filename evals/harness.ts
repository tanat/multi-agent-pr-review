#!/usr/bin/env tsx
import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // fallback to .env
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { FIXTURES, type Fixture } from './fixtures';
import { toPrContext } from './to-pr-context';
import { renderDiff } from '../lib/github';
import { SPECIALIST_PROMPT_VERSION, runSpecialist } from '../lib/specialists';
import { SPECIALISTS, type Finding, type Specialist } from '../lib/schemas';
import { MATCHER_VERSION, aggregate, scoreFixture, wilson, type SpecialistScore } from './score';
import { MODEL_IDS, costOf, type ModelKey, type Usage } from '../lib/models';
import { vcrMode, withRecording } from './cache';

interface Args {
  modelKey: ModelKey;
  repeat: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

  const model = get('model');
  const modelKey = model && model in MODEL_IDS ? (model as ModelKey) : 'sonnet';

  const raw = Number(get('repeat') ?? 1);
  const repeat = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 10) : 1;

  return { modelKey, repeat };
}

/**
 * Run the four specialists on a fixture, through the same rendering path the
 * app uses.
 *
 * Timings come from the recording on replay, so per-agent durations stay
 * comparable. Wall-clock does not: replaying four files off disk finishes in
 * microseconds and would report an absurd speedup, so parallelism is only
 * reported for fixtures whose four agents all ran live.
 */
async function reviewFixture(fixture: Fixture, index: number, modelKey: ModelKey, sample: number) {
  const diff = renderDiff(toPrContext(fixture, index));
  const wall0 = performance.now();
  const timed = await Promise.all(
    SPECIALISTS.map(async (s) => {
      const { findings, latencyMs, usage, cached } = await withRecording(
        {
          model: MODEL_IDS[modelKey],
          promptVersion: SPECIALIST_PROMPT_VERSION,
          fixture: fixture.name,
          specialist: s,
          sample,
          diff,
        },
        async () => {
          const t = performance.now();
          const out = await runSpecialist(s, diff, modelKey, 'eval');
          return { findings: out.findings, latencyMs: performance.now() - t, usage: out.usage };
        },
      );
      return { s, findings, ms: latencyMs, usage, cached, failed: false };
    }).map((p) =>
      // One specialist that fails to produce a parseable response must not
      // discard the whole sweep — the rest of this run is already paid for.
      // The failure is counted rather than swallowed: a lens that returns
      // nothing because it crashed is a different fact from one that returned
      // nothing because it found nothing, and averaging them together would
      // read as a well-behaved quiet lens.
      p.catch((err: unknown) => {
        console.warn(`  ! ${fixture.name}: a specialist failed — ${(err as Error).message.split('\n')[0]}`);
        return { s: null, findings: [] as Finding[], ms: 0, usage: null as Usage | null, cached: false, failed: true };
      }),
    ),
  );
  const bySpecialist = Object.fromEntries(SPECIALISTS.map((s) => [s, [] as Finding[]])) as Record<
    Specialist,
    Finding[]
  >;
  const usageBySpecialist = Object.fromEntries(SPECIALISTS.map((s) => [s, null])) as Record<
    Specialist,
    Usage | null
  >;
  for (const r of timed) {
    if (!r.s) continue;
    bySpecialist[r.s] = r.findings;
    usageBySpecialist[r.s] = r.usage;
  }

  return {
    bySpecialist,
    usageBySpecialist,
    wallMs: performance.now() - wall0,
    sumMs: timed.reduce((a, r) => a + r.ms, 0),
    cachedCount: timed.filter((r) => r.cached).length,
    failedCount: timed.filter((r) => r.failed).length,
  };
}

function pct(v: number | null): string {
  return v == null ? '   —  ' : `${(v * 100).toFixed(1).padStart(5)}%`;
}

/** Identifies the corpus, so rows measured against different fixtures are not compared. */
function corpusFingerprint(): string {
  const material = JSON.stringify(FIXTURES.map((f) => [f.name, f.diff, f.gold]));
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

function gitSha(): string | null {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

async function main() {
  const { modelKey, repeat } = parseArgs();
  const mode = vcrMode();
  const clean = FIXTURES.filter((f) => f.gold.length === 0);
  console.log(
    `Adversarial eval — ${FIXTURES.length} fixtures (${clean.length} clean), ` +
      `model=${modelKey}, repeat=${repeat}, vcr=${mode}\n`,
  );

  const allScores: SpecialistScore[][] = [];
  let totalWall = 0;
  let totalSum = 0;
  let cachedAgents = 0;
  let liveAgents = 0;
  let failedAgents = 0;

  // Findings emitted on a diff with nothing planted. The only place in the
  // corpus where a false positive is unambiguous — everywhere else, a finding
  // outside the gold set may still be a real defect we did not think to plant.
  const noise: Record<Specialist, number> = { security: 0, correctness: 0, tests: 0, style: 0 };
  // Recall split by whether the specialist's own prompt names the defect class.
  const primed = { caught: 0, total: 0 };
  const unprimed = { caught: 0, total: 0 };
  // Tokens per lens. The fan-out costs four calls per review whether or not the
  // fourth lens contributes anything, and until now nothing in the repo
  // recorded what that came to.
  const tokens: Record<Specialist, Usage> = Object.fromEntries(
    SPECIALISTS.map((s) => [s, { inputTokens: 0, outputTokens: 0 }]),
  ) as Record<Specialist, Usage>;
  let usageMissing = 0;

  for (let sample = 0; sample < repeat; sample++) {
    for (const [index, fx] of FIXTURES.entries()) {
      const { bySpecialist, usageBySpecialist, wallMs, sumMs, cachedCount, failedCount } = await reviewFixture(
        fx,
        index,
        modelKey,
        sample,
      );
      const scores = scoreFixture(bySpecialist, fx.gold);
      allScores.push(scores);

      cachedAgents += cachedCount;
      failedAgents += failedCount;
      liveAgents += SPECIALISTS.length - cachedCount - failedCount;
      if (cachedCount === 0) {
        totalWall += wallMs;
        totalSum += sumMs;
      }

      for (const s of SPECIALISTS) {
        const u = usageBySpecialist[s];
        if (!u) {
          usageMissing += 1;
          continue;
        }
        tokens[s].inputTokens += u.inputTokens;
        tokens[s].outputTokens += u.outputTokens;
      }

      if (fx.gold.length === 0) {
        for (const s of SPECIALISTS) noise[s] += bySpecialist[s].length;
      }

      const missed = new Set(scores.flatMap((r) => r.missedConcepts));
      for (const g of fx.gold) {
        const bucket = g.primed ? primed : unprimed;
        bucket.total += 1;
        if (!missed.has(g.concept)) bucket.caught += 1;
      }

      const found = scores.reduce((a, s) => a + s.foundCount, 0);
      const tp = scores.reduce((a, s) => a + s.truePositives, 0);
      const near = scores.reduce((a, s) => a + s.nearMisses, 0);
      const label = repeat > 1 ? `${fx.name} #${sample + 1}` : fx.name;
      const timing = cachedCount === SPECIALISTS.length ? 'replayed' : `wall=${wallMs.toFixed(0)}ms`;
      console.log(
        `${label.padEnd(26)} gold=${String(fx.gold.length).padStart(2)} found=${String(found).padStart(3)} ` +
          `caught=${String(tp).padStart(2)} near=${String(near).padStart(2)} ${timing}`,
      );
    }
  }

  const agg = aggregate(allScores);

  console.log('\nPer-specialist (micro-average over fixtures):');
  console.log('  specialist    gold found caught near  precision  recall');
  for (const s of agg.perSpecialist) {
    console.log(
      `  ${s.specialist.padEnd(12)} ${String(s.goldCount).padStart(4)} ${String(s.foundCount).padStart(5)} ` +
        `${String(s.truePositives).padStart(6)} ${String(s.nearMisses).padStart(4)}  ` +
        `${pct(s.precision)}  ${pct(s.recall)}`,
    );
  }

  const o = agg.overall;
  const ci = agg.recallInterval;
  console.log(
    `\nOverall recall ${pct(o.recall)} (${o.truePositives}/${o.goldCount})` +
      (ci ? `, 95% CI [${(ci.low * 100).toFixed(1)}%, ${(ci.high * 100).toFixed(1)}%]` : ''),
  );
  console.log(`Overall precision ${pct(o.precision)} — a lower bound: findings outside the gold set may still be real.`);

  const primedRate = primed.total ? primed.caught / primed.total : null;
  const unprimedRate = unprimed.total ? unprimed.caught / unprimed.total : null;
  console.log(
    `\nDefect classes the prompt names:        ${pct(primedRate)} (${primed.caught}/${primed.total})`,
  );
  console.log(
    `Defect classes the prompt does not name: ${pct(unprimedRate)} (${unprimed.caught}/${unprimed.total})`,
  );
  console.log('  A large gap means the lenses are matching keywords from their own instructions.');

  const cleanRuns = clean.length * repeat;
  if (cleanRuns > 0) {
    console.log(`\nFindings per clean diff (nothing planted — unambiguous noise):`);
    for (const s of SPECIALISTS) {
      console.log(`  ${s.padEnd(12)} ${(noise[s] / cleanRuns).toFixed(2)}`);
    }
  }

  if (agg.topMissedConcepts.length > 0) {
    console.log('\nMost-missed defects:');
    for (const m of agg.topMissedConcepts.slice(0, 8)) {
      console.log(`  ${String(m.misses).padStart(3)}×  ${m.concept}`);
    }
  }

  const totalCost = SPECIALISTS.reduce((a, s) => a + costOf(modelKey, tokens[s]), 0);
  if (totalCost > 0) {
    console.log('\nCost per lens (list price, whole run):');
    console.log('  specialist      in tok   out tok      cost   caught   $/caught');
    for (const s of SPECIALISTS) {
      const cost = costOf(modelKey, tokens[s]);
      const caught = agg.perSpecialist.find((r) => r.specialist === s)!.truePositives;
      const per = caught > 0 ? `$${(cost / caught).toFixed(4)}` : '       —';
      console.log(
        `  ${s.padEnd(12)} ${String(tokens[s].inputTokens).padStart(8)} ${String(tokens[s].outputTokens).padStart(9)} ` +
          `  $${cost.toFixed(4)} ${String(caught).padStart(6)}   ${per.padStart(8)}`,
      );
    }
    console.log(`  ${'TOTAL'.padEnd(12)} ${''.padStart(18)}   $${totalCost.toFixed(4)}`);
    if (usageMissing > 0) {
      console.log(`  (${usageMissing} agent runs replayed from recordings made before tokens were captured)`);
    }
  }

  const parallelism =
    totalWall > 0
      ? { totalAgentMs: Math.round(totalSum), totalWallMs: Math.round(totalWall), speedup: totalSum / totalWall }
      : null;
  console.log(
    parallelism
      ? `\nParallelism: ${totalSum.toFixed(0)}ms of agent work in ${totalWall.toFixed(0)}ms wall = ${parallelism.speedup.toFixed(2)}×.`
      : '\nParallelism: not measured — every fixture was replayed from cache.',
  );
  console.log(
    `Agents: ${liveAgents} live, ${cachedAgents} replayed` +
      (failedAgents ? `, ${failedAgents} FAILED to return a usable response.` : '.'),
  );

  const out = {
    runId: process.env.EVAL_RUN_ID ?? new Date().toISOString(),
    model: MODEL_IDS[modelKey],
    promptVersion: SPECIALIST_PROMPT_VERSION,
    // Without these three, rows either side of a change are silently
    // incomparable — which is how a matcher nobody could compare against
    // anything went unexamined.
    matcherVersion: MATCHER_VERSION,
    corpus: corpusFingerprint(),
    gitSha: gitSha(),
    fixtures: FIXTURES.length,
    cleanFixtures: clean.length,
    repeat,
    agents: { live: liveAgents, replayed: cachedAgents, failed: failedAgents },
    aggregate: agg,
    primedRecall: { ...primed, rate: primedRate, interval: wilson(primed.caught, primed.total) },
    unprimedRecall: { ...unprimed, rate: unprimedRate, interval: wilson(unprimed.caught, unprimed.total) },
    cost: {
      model: MODEL_IDS[modelKey],
      totalUsd: totalCost,
      perSpecialist: Object.fromEntries(
        SPECIALISTS.map((s) => [
          s,
          { ...tokens[s], usd: costOf(modelKey, tokens[s]) },
        ]),
      ),
      agentRunsWithoutUsage: usageMissing,
    },
    noisePerCleanDiff: Object.fromEntries(
      SPECIALISTS.map((s) => [s, cleanRuns ? noise[s] / cleanRuns : null]),
    ),
    parallelism,
  };

  const resultsPath = path.join(process.cwd(), 'evals', 'results.json');
  let history: unknown[] = [];
  if (fs.existsSync(resultsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      if (Array.isArray(parsed)) history = parsed;
    } catch {
      history = [];
    }
  }
  history.push(out);
  fs.writeFileSync(resultsPath, JSON.stringify(history, null, 2));
  console.log(`\nWrote run to ${resultsPath} (${history.length} total).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
