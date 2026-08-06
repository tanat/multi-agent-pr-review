import { propagateAttributes } from '@langfuse/tracing';
import { SPECIALISTS, type StoredFinding } from './schemas';
import { MODEL_IDS, type ModelKey } from './models';
import { fetchPr, findCommentByMarker, parsePrUrl, postReviewComment, renderDiff } from './github';
import { runSpecialist } from './specialists';
import * as store from '@/db/runs';

/**
 * The review is a durable state machine persisted in Postgres:
 *
 *   reviewing ──(all specialists done)──▶ awaiting_approval
 *      │                                        │ (human approves/rejects)
 *      │ (crash/restart)                        ▼
 *      └──── resumeRun() re-drives ───▶     publishing ──▶ done
 *
 * What "durable" means here, precisely, because the word is easy to over-claim:
 *
 *   - **Specialists run at least once.** A crash mid-review re-runs only the
 *     lenses missing from `meta.completed`, and inserts are idempotent on a
 *     deterministic key.
 *   - **Publish happens exactly once.** The attempt id is claimed before the
 *     comment is posted and echoed into the comment body, so a retry finds its
 *     own earlier post on GitHub instead of adding a second one.
 *   - **Every transition is compare-and-swap.** Two concurrent publishes cannot
 *     both win; the loser learns it lost rather than proceeding on a stale read.
 *   - **A failure records its stage**, so resume returns to where the run died
 *     rather than guessing.
 *   - **The run records the commit it reviewed**, so a push during the human
 *     pause is detected instead of silently re-reviewing a different diff.
 */

/** How long a run may go without checking in before it counts as abandoned. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

export class HeadMovedError extends Error {
  constructor(readonly from: string, readonly to: string) {
    super(`the pull request moved from ${from.slice(0, 7)} to ${to.slice(0, 7)} during the pause`);
  }
}

export class LostRaceError extends Error {}

function keyOf(run: { modelKey: string | null }, fallback: ModelKey = 'sonnet'): ModelKey {
  return run.modelKey && run.modelKey in MODEL_IDS ? (run.modelKey as ModelKey) : fallback;
}

/** Parse + fetch the PR and create the run row (status 'reviewing'). */
export async function createReview(prUrl: string, modelKey: ModelKey = 'sonnet'): Promise<string> {
  const { owner, repo, number } = parsePrUrl(prUrl);
  const pr = await fetchPr(owner, repo, number);
  return store.createRun({
    prUrl,
    owner,
    repo,
    number,
    title: pr.title,
    model: MODEL_IDS[modelKey],
    // Stored rather than passed around: resume used to default to sonnet, so a
    // gemini run that was interrupted silently finished on Claude while the
    // row still said gemini.
    modelKey,
    headSha: pr.headSha,
  });
}

/** Create the run and drive the review to completion (used by the CLI). */
export async function startReview(prUrl: string, modelKey: ModelKey = 'sonnet'): Promise<string> {
  const runId = await createReview(prUrl, modelKey);
  await reviewRun(runId, modelKey);
  return runId;
}

export interface ReviewOptions {
  /** Re-review at the new head instead of refusing when the branch has moved. */
  acceptNewHead?: boolean;
}

/**
 * Run the not-yet-completed specialists in parallel, persist their findings,
 * and advance to awaiting_approval.
 */
export async function reviewRun(
  runId: string,
  modelKey?: ModelKey,
  options: ReviewOptions = {},
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  // Already past the review stage — nothing to do (idempotent).
  if (run.status === 'awaiting_approval' || run.status === 'publishing' || run.status === 'done') {
    return;
  }

  const key = modelKey ?? keyOf(run);

  if (!(await store.transition(runId, ['reviewing', 'failed'], 'reviewing', { error: null, failedStage: null }))) {
    throw new LostRaceError('another worker is already reviewing this run');
  }

  try {
    const pr = await fetchPr(run.owner, run.repo, run.number);

    // The point of storing the sha. Without this, a push during the human pause
    // means resuming onto a different diff while findings already in the
    // database point at line numbers that have moved.
    if (run.headSha && pr.headSha !== run.headSha && !options.acceptNewHead) {
      throw new HeadMovedError(run.headSha, pr.headSha);
    }
    if (run.headSha !== pr.headSha) await store.setHeadSha(runId, pr.headSha);

    const diff = renderDiff(pr);
    const done = new Set(await store.getCompletedSpecialists(runId));
    const todo = SPECIALISTS.filter((s) => !done.has(s));

    const results = await propagateAttributes(
      { sessionId: `${run.owner}/${run.repo}#${run.number}`, tags: ['pr-review', key], metadata: { runId } },
      () =>
        // allSettled, not all. With Promise.all the first rejection resolved the
        // outer await while the other three specialists were still running —
        // they then wrote their findings into a run already marked failed, and
        // their completion markers landed after the status did.
        Promise.allSettled(
          todo.map(async (s) => {
            const { findings } = await runSpecialist(s, diff, key, runId);
            await store.completeSpecialist(runId, s, findings);
          }),
        ),
    );

    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const why = failures.map((f) => (f as PromiseRejectedResult).reason?.message ?? 'unknown').join('; ');
      throw new Error(`${failures.length} of ${todo.length} specialists failed: ${why}`);
    }

    await store.transition(runId, 'reviewing', 'awaiting_approval');
  } catch (err) {
    await store.setStatus(runId, 'failed', {
      error: (err as Error).message,
      failedStage: 'reviewing',
    });
    throw err;
  }
}

export interface PublishResult {
  mode: 'output' | 'github';
  body: string;
  url?: string;
  publishedCount: number;
  /** True when the comment already existed from an earlier attempt. */
  reused?: boolean;
}

/**
 * Publish the approved findings. Exactly once, including across a crash.
 *
 * The old order was: post the comment, mark the rows published, set 'done'. A
 * crash between the first and the second left a live comment on someone's pull
 * request and rows saying it had never been posted, and the retry posted it
 * again. Two concurrent requests did the same thing with no crash at all,
 * because the status check and the status write were separate statements.
 */
export async function publishRun(runId: string): Promise<PublishResult> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);

  // Compare-and-swap: exactly one caller moves the run into publishing.
  // 'publishing' is an allowed source so a crashed attempt can be retried.
  if (!(await store.transition(runId, ['awaiting_approval', 'publishing'], 'publishing'))) {
    throw new Error(`cannot publish a run in status "${run.status}"`);
  }

  try {
    const attemptId = await store.claimPublishAttempt(runId);
    const findings = await store.getFindings(runId);
    const toPublish = findings.filter((f) => f.decision === 'approved' && !f.published);
    const body = renderComment(run.owner, run.repo, run.number, toPublish, attemptId);

    let result: PublishResult = { mode: 'output', body, publishedCount: toPublish.length };

    if (process.env.PUBLISH_MODE === 'github' && toPublish.length > 0) {
      // Look before posting. The marker is this run's attempt id, embedded in
      // the comment body, so a retry recognises its own earlier post rather
      // than adding a second one.
      const existing = await findCommentByMarker(run.owner, run.repo, run.number, attemptId);
      if (existing) {
        result = { mode: 'github', body, url: existing.url, publishedCount: toPublish.length, reused: true };
      } else {
        const { url } = await postReviewComment(run.owner, run.repo, run.number, body);
        result = { mode: 'github', body, url, publishedCount: toPublish.length };
      }
      await store.recordPublishedComment(runId, result.url!);
    }

    // Only a real post makes a finding published. Flipping the flag in
    // output-only mode conflated "rendered a preview" with "posted", and the
    // exactly-once guarantee depends on that flag meaning one thing.
    if (result.mode === 'github') await store.markPublished(toPublish.map((f) => f.id));

    await store.transition(runId, 'publishing', 'done');
    return result;
  } catch (err) {
    await store.setStatus(runId, 'failed', {
      error: (err as Error).message,
      failedStage: 'publishing',
    });
    throw err;
  }
}

/** Re-drive an interrupted run from the stage it actually stopped at. */
export async function resumeRun(
  runId: string,
  modelKey?: ModelKey,
  options: ReviewOptions = {},
): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);

  switch (run.status) {
    case 'reviewing':
      await reviewRun(runId, modelKey ?? keyOf(run), options);
      return;
    case 'publishing':
      await publishRun(runId);
      return;
    case 'failed':
      // The whole reason failed_stage exists. Without it every failure went
      // back through the review stage, so a publish failure was silently
      // rewound to awaiting_approval and never retried.
      if (run.failedStage === 'publishing') {
        await store.setStatus(runId, 'publishing');
        await publishRun(runId);
      } else {
        await reviewRun(runId, modelKey ?? keyOf(run), options);
      }
      return;
    default:
      // awaiting_approval needs a human; done needs nothing.
      return;
  }
}

/** Re-drive runs that claim to be working but stopped checking in. */
export async function sweepStaleRuns(olderThanMs = STALE_AFTER_MS): Promise<string[]> {
  const stale = await store.findStaleRuns(olderThanMs);
  const resumed: string[] = [];
  for (const run of stale) {
    try {
      await resumeRun(run.id);
      resumed.push(run.id);
    } catch {
      // Already recorded on the run row; the sweep continues.
    }
  }
  return resumed;
}

const SEVERITY_EMOJI: Record<StoredFinding['severity'], string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

/** The idempotency marker embedded in a published comment. */
export function attemptMarker(attemptId: string): string {
  return `<!-- multi-agent-review:${attemptId} -->`;
}

/** Render approved findings as a Markdown PR comment. */
export function renderComment(
  owner: string,
  repo: string,
  number: number,
  findings: StoredFinding[],
  attemptId: string,
): string {
  const lines = [attemptMarker(attemptId), `### Multi-agent review of ${owner}/${repo}#${number}`, ''];
  if (findings.length === 0) {
    lines.push('No findings were approved for posting.');
    return lines.join('\n');
  }
  lines.push(`${findings.length} approved finding(s):`, '');
  for (const f of findings) {
    const loc = f.line != null ? `${f.file}:${f.line}` : f.file;
    lines.push(`${SEVERITY_EMOJI[f.severity]} **[${f.specialist}] ${f.title}** — \`${loc}\``);
    lines.push(`> ${f.rationale}`);
    if (f.suggestion) lines.push(`>`, `> _Suggestion:_ ${f.suggestion}`);
    lines.push('');
  }
  lines.push('—', '_Generated by a multi-agent review; findings were human-approved before posting._');
  return lines.join('\n');
}
