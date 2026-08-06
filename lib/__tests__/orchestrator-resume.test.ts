import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, RunStatus } from '../schemas';

/**
 * Resume is the claim this project is built on: a run survives a crash and an
 * hours-long human pause and picks up from its checkpoint. These tests drive
 * resumeRun() against a fake store to check that the claim holds for every
 * status a run can stop in.
 */

const store = vi.hoisted(() => ({
  getRun: vi.fn(),
  setStatus: vi.fn(async (_id: string, _status: string, _error?: string | null) => {}),
  getCompletedSpecialists: vi.fn(async () => [] as string[]),
  insertFindings: vi.fn(async () => {}),
  markSpecialistComplete: vi.fn(async () => {}),
  getFindings: vi.fn(async () => []),
  markPublished: vi.fn(async () => {}),
  createRun: vi.fn(async () => 'new-run'),
}));

const github = vi.hoisted(() => ({
  fetchPr: vi.fn(async () => ({
    owner: 'o', repo: 'r', number: 1, title: 't', body: null, author: 'a', files: [],
  })),
  renderDiff: vi.fn(() => 'diff'),
  postReviewComment: vi.fn(async () => ({ url: 'https://github.com/o/r/pull/1#c1' })),
  parsePrUrl: vi.fn(() => ({ owner: 'o', repo: 'r', number: 1 })),
}));

const runSpecialist = vi.hoisted(() => vi.fn(async () => []));

vi.mock('@/db/runs', () => store);
vi.mock('../github', () => github);
vi.mock('../specialists', () => ({ runSpecialist }));
vi.mock('@langfuse/tracing', () => ({
  propagateAttributes: (_a: unknown, fn: () => Promise<unknown>) => fn(),
}));

const { resumeRun } = await import('../orchestrator');

function run(status: RunStatus): Run {
  return {
    id: 'run-1', prUrl: 'https://github.com/o/r/pull/1', owner: 'o', repo: 'r', number: 1,
    title: 't', status, model: 'claude-sonnet-4-6', error: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  store.getCompletedSpecialists.mockResolvedValue([]);
  store.getFindings.mockResolvedValue([]);
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
    expect(store.setStatus).not.toHaveBeenCalled();
  });

  it('does nothing to a finished run', async () => {
    store.getRun.mockResolvedValue(run('done'));
    await resumeRun('run-1');
    expect(runSpecialist).not.toHaveBeenCalled();
  });

  it('finishes the publish for a run that died mid-publish', async () => {
    store.getRun.mockResolvedValue(run('publishing'));
    await resumeRun('run-1');
    expect(runSpecialist).not.toHaveBeenCalled();
    expect(store.setStatus).toHaveBeenCalledWith('run-1', 'done');
  });

  it('BUG: a run that failed during publish is silently rewound to awaiting_approval', async () => {
    // publishRun() catches its own error and writes status 'failed'. 'failed'
    // records THAT the run died, never WHERE, so resume has nothing to branch on
    // and sends it back through the review stage.
    //
    // meta.completed keeps that from being expensive — every specialist is
    // already listed, so none of them re-run. What it costs instead is the
    // truth: the run is set back to 'reviewing', then to 'awaiting_approval',
    // and setStatus defaults `error` to null, so the message explaining the
    // failure is erased. The operator is shown a normal run awaiting approval
    // with no trace that a publish was ever attempted, and the publish itself
    // is never retried.
    //
    // Phase 3 gives `failed` a memory of the stage it failed in, so resume
    // returns to publish and the error survives.
    store.getRun.mockResolvedValue(run('failed'));
    store.getCompletedSpecialists.mockResolvedValue(['security', 'correctness', 'tests', 'style']);

    await resumeRun('run-1');

    expect(runSpecialist).not.toHaveBeenCalled();
    expect(store.setStatus.mock.calls).toEqual([
      ['run-1', 'reviewing'],
      ['run-1', 'awaiting_approval'],
    ]);
    // Nothing in that sequence carries the error forward.
    expect(store.setStatus.mock.calls.some((c) => c[2])).toBe(false);
  });

  it('re-reviews from scratch only when the review really was unfinished', async () => {
    // The same 'failed' status with an empty checkpoint — a run that died during
    // the review — correctly re-runs everything. The status alone cannot tell
    // these two cases apart; only meta.completed can, and it happens to be
    // enough here. It is not enough for publish, which has no equivalent record.
    store.getRun.mockResolvedValue(run('failed'));
    store.getCompletedSpecialists.mockResolvedValue([]);
    await resumeRun('run-1');
    expect(runSpecialist).toHaveBeenCalledTimes(4);
  });

  it('BUG: a publish that posted to GitHub but died before bookkeeping can post twice', async () => {
    // publishRun(): postReviewComment() -> markPublished() -> setStatus('done').
    // A crash between the first and the second leaves `published` false on rows
    // whose text is already a live comment on the PR. The retry re-renders the
    // same findings and posts them again. Nothing in the code makes the GitHub
    // call idempotent, and `published` is set after the side effect rather than
    // claimed before it.
    const approved = [
      { id: 'f1', runId: 'run-1', specialist: 'security', file: 'a.ts', line: 1, severity: 'critical',
        title: 'SQL injection', rationale: 'concatenated input', suggestion: null,
        dedupKey: 'a.ts:1:sql injection', decision: 'approved', published: false },
    ];
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved as never);
    store.markPublished.mockRejectedValueOnce(new Error('connection reset'));
    process.env.PUBLISH_MODE = 'github';

    await expect(resumeRun('run-1')).rejects.toThrow('connection reset');
    expect(github.postReviewComment).toHaveBeenCalledTimes(1);

    // The rows still say unpublished, so the retry does it all over again.
    vi.clearAllMocks();
    store.getRun.mockResolvedValue(run('publishing'));
    store.getFindings.mockResolvedValue(approved as never);
    await resumeRun('run-1');
    expect(github.postReviewComment).toHaveBeenCalledTimes(1); // a second live comment
    delete process.env.PUBLISH_MODE;
  });
});
