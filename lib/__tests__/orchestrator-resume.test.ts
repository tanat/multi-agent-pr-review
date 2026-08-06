import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FailedStage, Run, RunStatus } from '../schemas';

/**
 * Resume is the claim this project rests on: a run survives a crash and an
 * hours-long human pause and picks up from its checkpoint. These tests drive
 * the orchestrator against a fake store through every status a run can stop in.
 *
 * Three of them were written first as passing tests describing bugs. They now
 * assert the fixed behaviour, and the diff between the two commits is the
 * record of what changed.
 */

const state = vi.hoisted(() => ({ status: 'reviewing' as RunStatus }));

const store = vi.hoisted(() => ({
  getRun: vi.fn(),
  // The fake tracks status so compare-and-swap behaves as it does in Postgres:
  // a transition only succeeds from a status the row is actually in.
  transition: vi.fn(async (_id: string, from: RunStatus | RunStatus[], to: RunStatus) => {
    const allowed = Array.isArray(from) ? from : [from];
    if (!allowed.includes(state.status)) return false;
    state.status = to;
    return true;
  }),
  setStatus: vi.fn(
    async (_id: string, status: RunStatus, _fields?: { error?: string | null; failedStage?: FailedStage | null }) => {
      state.status = status;
    },
  ),
  setHeadSha: vi.fn(async () => {}),
  heartbeat: vi.fn(async () => {}),
  getCompletedSpecialists: vi.fn(async () => [] as string[]),
  completeSpecialist: vi.fn(async () => {}),
  insertFindings: vi.fn(async () => {}),
  markSpecialistComplete: vi.fn(async () => {}),
  getFindings: vi.fn(async () => [] as unknown[]),
  markPublished: vi.fn(async () => {}),
  claimPublishAttempt: vi.fn(async () => 'attempt-1'),
  recordPublishedComment: vi.fn(async () => {}),
  findStaleRuns: vi.fn(async () => [] as Run[]),
  createRun: vi.fn(async () => 'new-run'),
}));

const github = vi.hoisted(() => ({
  fetchPr: vi.fn(async () => ({
    owner: 'o', repo: 'r', number: 1, headSha: 'sha-original',
    title: 't', body: null, author: 'a', files: [],
  })),
  renderDiff: vi.fn(() => 'diff'),
  postReviewComment: vi.fn(async (_o: string, _r: string, _n: number, _body: string) => ({
    url: 'https://github.com/o/r/pull/1#issuecomment-1',
  })),
  findCommentByMarker: vi.fn(async () => null as { url: string } | null),
  parsePrUrl: vi.fn(() => ({ owner: 'o', repo: 'r', number: 1 })),
}));

const runSpecialist = vi.hoisted(() => vi.fn(async () => ({ findings: [], usage: { inputTokens: 1, outputTokens: 1 } })));

vi.mock('@/db/runs', () => store);
vi.mock('../github', () => github);
vi.mock('../specialists', () => ({ runSpecialist }));
vi.mock('@langfuse/tracing', () => ({
  propagateAttributes: (_a: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { HeadMovedError, publishRun, resumeRun } = await import('../orchestrator');

function run(status: RunStatus, over: Partial<Run> = {}): Run {
  state.status = status;
  return {
    id: 'run-1', prUrl: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1,
    title: 't', status, model: 'claude-sonnet-4-6', modelKey: 'sonnet',
    headSha: 'sha-original', failedStage: null, publishAttemptId: null,
    publishedCommentUrl: null, error: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getCompletedSpecialists.mockResolvedValue([]);
  store.getFindings.mockResolvedValue([]);
  store.claimPublishAttempt.mockResolvedValue('attempt-1');
  github.findCommentByMarker.mockResolvedValue(null);
  github.fetchPr.mockResolvedValue({
    owner: 'o', repo: 'r', number: 1, headSha: 'sha-original',
    title: 't', body: null, author: 'a', files: [],
  });
  delete process.env.PUBLISH_MODE;
});

describe('resumeRun', () => {
  it('re-drives a run that died mid-review', async () => {
    store.getRun.mockResolvedValue(run('reviewing'));
    await resumeRun('run-1');
    expect(runSpecialist).toHaveBeenCalledTimes(4);
  });

  it('skips the specialists that already finished', async () => {
    store.getRun.mockResolvedValue(run('reviewing'));
    store.getCompletedSpecialists.mockResolvedValue(['security', 'correctness']);
    await resumeRun('run-1');
    expect(runSpecialist).toHaveBeenCalledTimes(2);
  });

  it('does nothing while a human still owes a decision', async () => {
    store.getRun.mockResolvedValue(run('awaiting_approval'));
    await resumeRun('run-1');
    expect(runSpecialist).not.toHaveBeenCalled();
    expect(store.transition).not.toHaveBeenCalled();
  });

  it('does nothing to a finished run', async () => {
    store.getRun.mockResolvedValue(run('done'));
    await resumeRun('run-1');
    expect(runSpecialist).not.toHaveBeenCalled();
  });

  it('resumes the run on the model it was started with', async () => {
    // resumeRun used to default to sonnet, so an interrupted gemini run
    // silently finished on Claude while the row still said gemini.
    store.getRun.mockResolvedValue(run('reviewing', { modelKey: 'gemini-flash' }));
    await resumeRun('run-1');
    expect(runSpecialist).toHaveBeenCalledWith(expect.anything(), 'diff', 'gemini-flash', 'run-1');
  });
});

describe('a failed run resumes at the stage it failed in', () => {
  it('FIXED: a publish failure retries the publish instead of rewinding to approval', async () => {
    // Previously: publishRun caught its own error and wrote 'failed', which
    // recorded that the run died but never where. Resume sent it back through
    // the review stage, meta.completed made that a no-op, and the run landed
    // back in awaiting_approval with its error erased — no trace that a publish
    // had ever been attempted, and no retry.
    store.getRun.mockResolvedValue(run('failed', { failedStage: 'publishing' }));
    store.getCompletedSpecialists.mockResolvedValue(['security', 'correctness', 'tests', 'style']);

    await resumeRun('run-1');

    expect(runSpecialist).not.toHaveBeenCalled();
    expect(store.claimPublishAttempt).toHaveBeenCalledWith('run-1');
    expect(store.transition).toHaveBeenCalledWith('run-1', 'publishing', 'done');
  });

  it('re-reviews when the review is what failed', async () => {
    store.getRun.mockResolvedValue(run('failed', { failedStage: 'reviewing' }));
    await resumeRun('run-1');
    expect(runSpecialist).toHaveBeenCalledTimes(4);
  });
});

describe('publishing exactly once', () => {
  const approved = [
    { id: 'f1', runId: 'run-1', specialist: 'security', file: 'a.ts', line: 1, severity: 'critical',
      title: 'SQL injection', rationale: 'concatenated input', suggestion: null,
      dedupKey: 'a.ts:1:sql injection', decision: 'approved', published: false },
  ];

  it('FIXED: a retry finds its own earlier comment instead of posting a second one', async () => {
    // The old order was post, then mark published, then set done. A crash
    // between the first two left a live comment on someone else's pull request
    // and rows saying it had never been posted, and the retry posted it again.
    // The attempt id is now claimed first and embedded in the comment body, so
    // the retry recognises its own post.
    process.env.PUBLISH_MODE = 'github';
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved);
    github.findCommentByMarker.mockResolvedValue({ url: 'https://github.com/o/r/pull/1#issuecomment-1' });

    const result = await publishRun('run-1');

    expect(github.postReviewComment).not.toHaveBeenCalled();
    expect(result).toMatchObject({ mode: 'github', reused: true });
    expect(store.markPublished).toHaveBeenCalledWith(['f1']);
  });

  it('posts when there is no earlier comment to find', async () => {
    process.env.PUBLISH_MODE = 'github';
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved);

    await publishRun('run-1');

    expect(github.postReviewComment).toHaveBeenCalledTimes(1);
    expect(store.recordPublishedComment).toHaveBeenCalledWith(
      'run-1',
      'https://github.com/o/r/pull/1#issuecomment-1',
    );
  });

  it('embeds the attempt id in the comment so the retry has something to match', async () => {
    process.env.PUBLISH_MODE = 'github';
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved);

    await publishRun('run-1');

    const body = github.postReviewComment.mock.calls[0][3];
    expect(body).toContain('multi-agent-review:attempt-1');
  });

  it('FIXED: the loser of a concurrent publish is told it lost', async () => {
    // Two requests used to read the status, both decide it was safe, and both
    // post. The transition is now compare-and-swap, so exactly one wins.
    store.getRun.mockResolvedValue(run('done'));
    await expect(publishRun('run-1')).rejects.toThrow(/cannot publish/);
    expect(github.postReviewComment).not.toHaveBeenCalled();
  });

  it('does not mark findings published when nothing was posted', async () => {
    // Output-only renders a preview into the page. Flipping `published` there
    // conflated "shown to a human" with "posted to GitHub", and the
    // exactly-once guarantee depends on that flag meaning one thing.
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved);

    const result = await publishRun('run-1');

    expect(result.mode).toBe('output');
    expect(store.markPublished).not.toHaveBeenCalled();
  });

  it('records the stage when a publish fails', async () => {
    process.env.PUBLISH_MODE = 'github';
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved);
    github.postReviewComment.mockRejectedValueOnce(new Error('connection reset'));

    await expect(publishRun('run-1')).rejects.toThrow('connection reset');
    expect(store.setStatus).toHaveBeenCalledWith('run-1', 'failed', {
      error: 'connection reset',
      failedStage: 'publishing',
    });
  });
});

describe('the branch moving under a paused run', () => {
  it('refuses to resume onto a diff that is no longer the one that was reviewed', async () => {
    // The findings already in the database point at line numbers in the old
    // commit. Re-reviewing the new head silently would leave them there,
    // attached to code that has moved.
    store.getRun.mockResolvedValue(run('reviewing'));
    github.fetchPr.mockResolvedValue({
      owner: 'o', repo: 'r', number: 1, headSha: 'sha-moved',
      title: 't', body: null, author: 'a', files: [],
    });

    await expect(resumeRun('run-1')).rejects.toThrow(HeadMovedError);
    expect(runSpecialist).not.toHaveBeenCalled();
    expect(store.setStatus).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ failedStage: 'reviewing' }),
    );
  });

  it('re-reviews the new head when told to', async () => {
    store.getRun.mockResolvedValue(run('reviewing'));
    github.fetchPr.mockResolvedValue({
      owner: 'o', repo: 'r', number: 1, headSha: 'sha-moved',
      title: 't', body: null, author: 'a', files: [],
    });

    await resumeRun('run-1', undefined, { acceptNewHead: true });

    expect(runSpecialist).toHaveBeenCalledTimes(4);
    expect(store.setHeadSha).toHaveBeenCalledWith('run-1', 'sha-moved');
  });
});

describe('a specialist failing mid-review', () => {
  it('lets the others finish and records the stage', async () => {
    // Promise.all resolved the outer await on the first rejection while the
    // other three were still running; they then wrote into a run already marked
    // failed. allSettled waits for all four before deciding the status.
    store.getRun.mockResolvedValue(run('reviewing'));
    runSpecialist
      .mockRejectedValueOnce(new Error('gateway 503'))
      .mockResolvedValue({ findings: [], usage: { inputTokens: 1, outputTokens: 1 } });

    await expect(resumeRun('run-1')).rejects.toThrow(/specialists failed/);

    expect(runSpecialist).toHaveBeenCalledTimes(4);
    expect(store.completeSpecialist).toHaveBeenCalledTimes(3);
    expect(store.setStatus).toHaveBeenCalledWith(
      'run-1',
      'failed',
      expect.objectContaining({ failedStage: 'reviewing' }),
    );
  });
});
