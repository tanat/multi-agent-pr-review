import { propagateAttributes } from '@langfuse/tracing';
import { SPECIALISTS, type StoredFinding } from './schemas';
import { MODEL_IDS, type ModelKey } from './models';
import { fetchPr, parsePrUrl, postReviewComment, renderDiff } from './github';
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
 * Every step is idempotent, so a run survives a process restart or the hours-long
 * human pause and resumes from its checkpoint — that's the point of the project.
 */

export interface ReviewStartResult {
  runId: string;
  status: string;
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
  });
}

/** Create the run and drive the review to completion (used by the CLI). */
export async function startReview(prUrl: string, modelKey: ModelKey = 'sonnet'): Promise<string> {
  const runId = await createReview(prUrl, modelKey);
  await reviewRun(runId, modelKey);
  return runId;
}

/**
 * Run the not-yet-completed specialists in parallel, persist their findings, and
 * advance to awaiting_approval. Resumable: specialists already recorded in
 * meta.completed are skipped, and findings inserts are idempotent (dedup key).
 */
export async function reviewRun(runId: string, modelKey: ModelKey = 'sonnet'): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  // Already past the review stage — nothing to do (idempotent).
  if (run.status === 'awaiting_approval' || run.status === 'publishing' || run.status === 'done') {
    return;
  }

  await store.setStatus(runId, 'reviewing');
  try {
    const pr = await fetchPr(run.owner, run.repo, run.number);
    const diff = renderDiff(pr);
    const done = new Set(await store.getCompletedSpecialists(runId));
    const todo = SPECIALISTS.filter((s) => !done.has(s));

    // Group every specialist span under one Langfuse trace for this run.
    await propagateAttributes(
      { sessionId: `${run.owner}/${run.repo}#${run.number}`, tags: ['pr-review', modelKey], metadata: { runId } },
      () =>
        Promise.all(
          todo.map(async (s) => {
            const { findings } = await runSpecialist(s, diff, modelKey, runId);
            await store.insertFindings(runId, s, findings);
            await store.markSpecialistComplete(runId, s);
          }),
        ),
    );

    await store.setStatus(runId, 'awaiting_approval');
  } catch (err) {
    await store.setStatus(runId, 'failed', (err as Error).message);
    throw err;
  }
}

export interface PublishResult {
  mode: 'output' | 'github';
  body: string;
  url?: string;
  publishedCount: number;
}

/** Publish the approved (and not-yet-published) findings. Idempotent per finding. */
export async function publishRun(runId: string): Promise<PublishResult> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  if (run.status !== 'awaiting_approval' && run.status !== 'publishing') {
    throw new Error(`cannot publish a run in status "${run.status}"`);
  }

  await store.setStatus(runId, 'publishing');
  try {
    const findings = await store.getFindings(runId);
    const toPublish = findings.filter((f) => f.decision === 'approved' && !f.published);
    const body = renderComment(run.owner, run.repo, run.number, toPublish);

    let result: PublishResult = { mode: 'output', body, publishedCount: toPublish.length };
    if (process.env.PUBLISH_MODE === 'github' && toPublish.length > 0) {
      const { url } = await postReviewComment(run.owner, run.repo, run.number, body);
      result = { mode: 'github', body, url, publishedCount: toPublish.length };
    }

    await store.markPublished(toPublish.map((f) => f.id));
    await store.setStatus(runId, 'done');
    return result;
  } catch (err) {
    await store.setStatus(runId, 'failed', (err as Error).message);
    throw err;
  }
}

/** Re-drive an interrupted run from whatever checkpoint it stopped at. */
export async function resumeRun(runId: string, modelKey: ModelKey = 'sonnet'): Promise<void> {
  const run = await store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);
  switch (run.status) {
    case 'reviewing':
    case 'failed':
      await reviewRun(runId, modelKey);
      return;
    case 'publishing':
      await publishRun(runId);
      return;
    default:
      // awaiting_approval needs a human; done needs nothing.
      return;
  }
}

const SEVERITY_EMOJI: Record<StoredFinding['severity'], string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

/** Render approved findings as a Markdown PR comment. */
function renderComment(owner: string, repo: string, number: number, findings: StoredFinding[]): string {
  if (findings.length === 0) {
    return `### Multi-agent review of ${owner}/${repo}#${number}\n\nNo findings were approved for posting.`;
  }
  const lines = [`### Multi-agent review of ${owner}/${repo}#${number}`, '', `${findings.length} approved finding(s):`, ''];
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
