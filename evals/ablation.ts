#!/usr/bin/env tsx
import { config } from 'dotenv';
config({ path: '.env.local' });
config();
import { FIXTURES, type GoldIssue } from './fixtures';
import { toPrContext } from './to-pr-context';
import { renderDiff } from '../lib/github';
import { SPECIALIST_PROMPT_VERSION } from '../lib/specialists';
import { SPECIALISTS, type Finding, type Specialist } from '../lib/schemas';
import { matchesConcept, matchesLocation } from './score';
import { MODEL_IDS, costOf, type ModelKey, type Usage } from '../lib/models';
import { readRecording, recordingKey } from './cache';

/**
 * Does the four-way fan-out earn its cost?
 *
 * DECISIONS.md answers yes and cites a 2.83× parallelism speedup. That number
 * cannot support the claim: it is an arithmetic property of running four calls
 * concurrently, bounded above by four whatever the lenses find, and it says
 * nothing about tokens — the fan-out costs 4× per review regardless of how fast
 * the calls overlap.
 *
 * The question a lens has to answer is marginal: **which defects would go
 * uncaught if this lens were not there?** So this script deliberately drops the
 * specialist partition the scorer uses and asks whether any lens catches a
 * defect no other lens found. A `style` lens whose every catch is also caught by
 * `correctness` is paying full price for nothing, and the per-specialist
 * precision table cannot show that — it scores each lens only against the gold
 * assigned to it.
 *
 * Runs entirely off the recordings in evals/cache, so it costs nothing and can
 * be re-run after any scorer change.
 */

interface Loaded {
  fixture: string;
  gold: GoldIssue[];
  findings: Record<Specialist, Finding[]>;
  usage: Record<Specialist, Usage | null>;
}

function loadRecorded(modelKey: ModelKey, sample = 0): Loaded[] {
  const out: Loaded[] = [];
  let missing = 0;

  for (const [index, fx] of FIXTURES.entries()) {
    const diff = renderDiff(toPrContext(fx, index));
    const findings = {} as Record<Specialist, Finding[]>;
    const usage = {} as Record<Specialist, Usage | null>;
    let complete = true;

    for (const s of SPECIALISTS) {
      const rec = readRecording(
        recordingKey({
          model: MODEL_IDS[modelKey],
          promptVersion: SPECIALIST_PROMPT_VERSION,
          fixture: fx.name,
          specialist: s,
          sample,
          diff,
        }),
      );
      if (!rec) {
        complete = false;
        break;
      }
      findings[s] = rec.findings;
      usage[s] = rec.usage ?? null;
    }

    if (!complete) {
      missing += 1;
      continue;
    }
    out.push({ fixture: fx.name, gold: fx.gold, findings, usage });
  }

  if (missing > 0) {
    console.log(`(${missing} fixtures have no complete recording and were skipped — run EVAL_VCR=record pnpm eval)\n`);
  }
  return out;
}

/** Which lenses caught this defect, ignoring which lens it was assigned to. */
function cattersOf(g: GoldIssue, findings: Record<Specialist, Finding[]>): Specialist[] {
  return SPECIALISTS.filter((s) =>
    (findings[s] ?? []).some((f) => matchesLocation(f, g) && matchesConcept(f, g)),
  );
}

function main() {
  const arg = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1];
  const modelKey: ModelKey = arg && arg in MODEL_IDS ? (arg as ModelKey) : 'sonnet';

  const loaded = loadRecorded(modelKey);
  if (loaded.length === 0) {
    console.error('No recordings found. Run: EVAL_VCR=record pnpm eval');
    process.exit(1);
  }

  console.log(`Lens ablation — ${loaded.length} fixtures, model=${modelKey}, from recordings\n`);

  // Who caught what, with the specialist partition removed.
  const catchers: { gold: GoldIssue; by: Specialist[] }[] = [];
  for (const l of loaded) {
    for (const g of l.gold) catchers.push({ gold: g, by: cattersOf(g, l.findings) });
  }

  const totalGold = catchers.length;
  const caughtByAny = catchers.filter((c) => c.by.length > 0).length;

  const cost = {} as Record<Specialist, number>;
  for (const s of SPECIALISTS) {
    cost[s] = loaded.reduce((a, l) => a + (l.usage[s] ? costOf(modelKey, l.usage[s]!) : 0), 0);
  }
  const totalCost = SPECIALISTS.reduce((a, s) => a + cost[s], 0);
  const haveCost = totalCost > 0;

  console.log(`All four lenses catch ${caughtByAny}/${totalGold} defects` + (haveCost ? ` for $${totalCost.toFixed(4)}` : ''));
  console.log('(a defect counts as caught if ANY lens named it, wherever it was filed)\n');

  console.log('Per lens:');
  console.log('  lens          caught  unique  ' + (haveCost ? '     cost  $/unique' : ''));
  for (const s of SPECIALISTS) {
    const caught = catchers.filter((c) => c.by.includes(s)).length;
    const unique = catchers.filter((c) => c.by.length === 1 && c.by[0] === s).length;
    const money = haveCost
      ? `  $${cost[s].toFixed(4)}  ${unique > 0 ? `$${(cost[s] / unique).toFixed(4)}` : '       —'}`
      : '';
    console.log(`  ${s.padEnd(12)} ${String(caught).padStart(6)} ${String(unique).padStart(7)}${money}`);
  }

  console.log('\nLeave one out:');
  console.log('  dropped       caught  lost  ' + (haveCost ? '     cost  saved' : ''));
  for (const dropped of SPECIALISTS) {
    const kept = SPECIALISTS.filter((s) => s !== dropped);
    const caught = catchers.filter((c) => c.by.some((s) => kept.includes(s))).length;
    const money = haveCost
      ? `  $${(totalCost - cost[dropped]).toFixed(4)}  ${((cost[dropped] / totalCost) * 100).toFixed(0)}%`
      : '';
    console.log(
      `  ${dropped.padEnd(12)} ${String(caught).padStart(6)} ${String(caughtByAny - caught).padStart(5)}${money}`,
    );
  }

  const nobody = catchers.filter((c) => c.by.length === 0);
  if (nobody.length > 0) {
    console.log(`\nCaught by nobody (${nobody.length}):`);
    for (const c of nobody.slice(0, 15)) {
      console.log(`  ${c.gold.concept.padEnd(34)} ${c.gold.primed ? '' : '(class the prompt never names)'}`);
    }
  }

  const overlap = catchers.filter((c) => c.by.length > 1).length;
  console.log(
    `\n${overlap}/${caughtByAny} caught defects were found by more than one lens — ` +
      'the raw material for a consensus signal, and the reason dedup matters.',
  );
}

main();
