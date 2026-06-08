#!/usr/bin/env tsx
import 'dotenv/config';
import { startReview, publishRun, reviewRun } from '../lib/orchestrator';
import * as store from '../db/runs';
import { db } from '../db/client';
import type { ModelKey } from '../lib/models';

/**
 * End-to-end exercise of the orchestrator without the UI:
 *   review a PR -> print findings -> prove idempotent re-run -> approve all ->
 *   publish (output mode) -> print the rendered comment.
 *
 * Usage: pnpm tsx scripts/review-cli.ts <pr-url> [--model=sonnet|gpt-4o|gemini-flash|gemini-pro]
 */
async function main() {
  const prUrl = process.argv[2];
  if (!prUrl) {
    console.error('usage: pnpm tsx scripts/review-cli.ts <github-pr-url> [--model=...]');
    process.exit(2);
  }
  const modelKey = (process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? 'sonnet') as ModelKey;

  console.log(`Reviewing ${prUrl} (model=${modelKey})…\n`);
  const runId = await startReview(prUrl, modelKey);
  let run = await store.getRun(runId);
  console.log(`run ${runId} → status=${run?.status}`);

  const findings = await store.getFindings(runId);
  console.log(`\n${findings.length} finding(s):`);
  for (const f of findings) {
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
    console.log(`  [${f.specialist}/${f.severity}] ${loc} — ${f.title}`);
  }

  // Durability/idempotency: re-running review must not duplicate findings.
  await reviewRun(runId, modelKey);
  const after = await store.getFindings(runId);
  console.log(
    `\nidempotency: re-ran review → ${after.length} finding(s) ` +
      `(expected ${findings.length}) ${after.length === findings.length ? 'OK' : 'MISMATCH'}`,
  );

  // HITL: approve everything, then publish (output mode prints the comment).
  await store.setAllDecisions(runId, 'approved');
  const result = await publishRun(runId);
  run = await store.getRun(runId);
  console.log(`\npublished ${result.publishedCount} (mode=${result.mode}) → final status=${run?.status}`);
  console.log('\n----- rendered comment -----\n' + result.body);
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error(err);
    await db.end();
    process.exit(1);
  });
