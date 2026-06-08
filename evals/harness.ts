#!/usr/bin/env tsx
import { config } from 'dotenv';
config({ path: '.env.local' });
config(); // fallback to .env
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES } from './fixtures';
import { runSpecialist } from '../lib/specialists';
import { SPECIALISTS, type Finding, type Specialist } from '../lib/schemas';
import { aggregate, scoreFixture, type SpecialistScore } from './score';
import { MODEL_IDS, type ModelKey } from '../lib/models';

function parseModel(): ModelKey {
  const arg = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1];
  if (arg && arg in MODEL_IDS) return arg as ModelKey;
  return 'sonnet';
}

/** Run the four specialists on a diff in parallel; report wall time + per-agent time. */
async function reviewFixture(diff: string, modelKey: ModelKey) {
  const wall0 = performance.now();
  const timed = await Promise.all(
    SPECIALISTS.map(async (s) => {
      const t = performance.now();
      const findings = await runSpecialist(s, diff, modelKey, 'eval');
      return { s, findings, ms: performance.now() - t };
    }),
  );
  const wallMs = performance.now() - wall0;
  const sumMs = timed.reduce((a, r) => a + r.ms, 0);
  const bySpecialist = Object.fromEntries(timed.map((r) => [r.s, r.findings])) as Record<Specialist, Finding[]>;
  return { bySpecialist, wallMs, sumMs };
}

async function main() {
  const modelKey = parseModel();
  console.log(`Adversarial eval — ${FIXTURES.length} fixtures, model=${modelKey}\n`);

  const allScores: SpecialistScore[][] = [];
  let totalWall = 0;
  let totalSum = 0;

  for (const fx of FIXTURES) {
    const { bySpecialist, wallMs, sumMs } = await reviewFixture(fx.diff, modelKey);
    const scores = scoreFixture(bySpecialist, fx.gold);
    allScores.push(scores);
    totalWall += wallMs;
    totalSum += sumMs;
    const found = scores.reduce((a, s) => a + s.foundCount, 0);
    const tp = scores.reduce((a, s) => a + s.truePositives, 0);
    const gold = scores.reduce((a, s) => a + s.goldCount, 0);
    console.log(
      `${fx.name.padEnd(22)} gold=${gold} found=${found} tp=${tp} ` +
        `wall=${wallMs.toFixed(0)}ms speedup=${(sumMs / wallMs).toFixed(2)}x`,
    );
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
  console.log(
    `Parallelism: ${totalSum.toFixed(0)}ms of agent work in ${totalWall.toFixed(0)}ms wall = ` +
      `${(totalSum / totalWall).toFixed(2)}x speedup from running specialists concurrently.`,
  );

  const out = {
    runId: process.env.EVAL_RUN_ID ?? 'local',
    model: MODEL_IDS[modelKey],
    fixtures: FIXTURES.length,
    aggregate: agg,
    parallelism: { totalAgentMs: Math.round(totalSum), totalWallMs: Math.round(totalWall), speedup: totalSum / totalWall },
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
