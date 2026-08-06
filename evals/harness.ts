#!/usr/bin/env tsx
import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // fallback to .env
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './fixtures';
import { SPECIALIST_PROMPT_VERSION, runSpecialist } from '../lib/specialists';
import { SPECIALISTS, type Finding, type Specialist } from '../lib/schemas';
import { aggregate, scoreFixture, type SpecialistScore } from './score';
import { MODEL_IDS, type ModelKey } from '../lib/models';
import { vcrMode, withRecording } from './cache';

function parseModel(): ModelKey {
  const arg = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1];
  if (arg && arg in MODEL_IDS) return arg as ModelKey;
  return 'sonnet';
}

/**
 * Run the four specialists on a diff in parallel.
 *
 * Timings come from the recording when a run is replayed, so the per-agent
 * durations stay comparable across runs. Wall-clock does not: replaying four
 * files off disk finishes in microseconds and would report an absurd speedup.
 * The harness therefore only reports parallelism for runs that actually called
 * the model, rather than printing a number that measures the filesystem.
 */
async function reviewFixture(fixture: string, diff: string, modelKey: ModelKey) {
  const wall0 = performance.now();
  const timed = await Promise.all(
    SPECIALISTS.map(async (s) => {
      const { findings, latencyMs, cached } = await withRecording(
        { model: MODEL_IDS[modelKey], promptVersion: SPECIALIST_PROMPT_VERSION, fixture, specialist: s, diff },
        async () => {
          const t = performance.now();
          const out = await runSpecialist(s, diff, modelKey, 'eval');
          return { findings: out, latencyMs: performance.now() - t };
        },
      );
      return { s, findings, ms: latencyMs, cached };
    }),
  );
  const wallMs = performance.now() - wall0;
  const sumMs = timed.reduce((a, r) => a + r.ms, 0);
  const bySpecialist = Object.fromEntries(timed.map((r) => [r.s, r.findings])) as Record<Specialist, Finding[]>;
  return { bySpecialist, wallMs, sumMs, cachedCount: timed.filter((r) => r.cached).length };
}

async function main() {
  const modelKey = parseModel();
  const mode = vcrMode();
  console.log(`Adversarial eval — ${FIXTURES.length} fixtures, model=${modelKey}, vcr=${mode}\n`);

  const allScores: SpecialistScore[][] = [];
  let totalWall = 0;
  let totalSum = 0;
  let cachedAgents = 0;
  let liveAgents = 0;

  for (const fx of FIXTURES) {
    const { bySpecialist, wallMs, sumMs, cachedCount } = await reviewFixture(fx.name, fx.diff, modelKey);
    const scores = scoreFixture(bySpecialist, fx.gold);
    allScores.push(scores);
    cachedAgents += cachedCount;
    liveAgents += SPECIALISTS.length - cachedCount;
    // Only a fixture whose four agents all ran live contributes a meaningful
    // wall-clock number; a partly-replayed one would understate it.
    if (cachedCount === 0) {
      totalWall += wallMs;
      totalSum += sumMs;
    }
    const found = scores.reduce((a, s) => a + s.foundCount, 0);
    const tp = scores.reduce((a, s) => a + s.truePositives, 0);
    const gold = scores.reduce((a, s) => a + s.goldCount, 0);
    const timing = cachedCount === SPECIALISTS.length ? 'replayed' : `wall=${wallMs.toFixed(0)}ms`;
    console.log(`${fx.name.padEnd(22)} gold=${gold} found=${found} tp=${tp} ${timing}`);
  }

  const agg = aggregate(allScores);
  console.log('\nPer-specialist (micro-avg over fixtures):');
  console.log('  specialist    gold found  tp   precision recall  f1');
  for (const s of agg.perSpecialist) {
    console.log(
      `  ${s.specialist.padEnd(12)} ${String(s.goldCount).padStart(3)} ${String(s.foundCount).padStart(4)} ` +
        `${String(s.truePositives).padStart(3)}   ${s.precision.toFixed(2).padStart(7)} ${s.recall.toFixed(2).padStart(6)} ${s.f1.toFixed(2)}`,
    );
  }
  const o = agg.overall;
  console.log(
    `\nOverall: precision=${o.precision.toFixed(2)} recall=${o.recall.toFixed(2)} f1=${o.f1.toFixed(2)} ` +
      `(tp=${o.truePositives}/gold=${o.goldCount}, found=${o.foundCount})`,
  );
  const parallelism =
    totalWall > 0
      ? { totalAgentMs: Math.round(totalSum), totalWallMs: Math.round(totalWall), speedup: totalSum / totalWall }
      : null;

  if (parallelism) {
    console.log(
      `Parallelism: ${totalSum.toFixed(0)}ms of agent work in ${totalWall.toFixed(0)}ms wall = ` +
        `${parallelism.speedup.toFixed(2)}x speedup from running specialists concurrently.`,
    );
  } else {
    console.log('Parallelism: not measured — every fixture was replayed from cache.');
  }
  console.log(`Agents: ${liveAgents} live, ${cachedAgents} replayed.`);

  const out = {
    runId: process.env.EVAL_RUN_ID ?? 'local',
    model: MODEL_IDS[modelKey],
    promptVersion: SPECIALIST_PROMPT_VERSION,
    fixtures: FIXTURES.length,
    // Recorded so a run can never be mistaken for a fresh measurement of the
    // model when it was mostly a measurement of the disk.
    agents: { live: liveAgents, replayed: cachedAgents },
    aggregate: agg,
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
