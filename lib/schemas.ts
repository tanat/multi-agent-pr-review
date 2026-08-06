import { z } from 'zod';

export const SPECIALISTS = ['security', 'correctness', 'tests', 'style'] as const;
export type Specialist = (typeof SPECIALISTS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * How long a title may be before it stops being scannable in the UI.
 *
 * This is a presentation rule, and it used to be enforced on the wire as
 * `.max(120)`. `generateObject` validates the whole response against one
 * schema, so a single verbose title threw the entire array away — nineteen
 * usable findings discarded because the twentieth was wordy. It killed a real
 * eval run on a finding that was correct and well argued, and in the app it
 * takes down a whole specialist, whose failure marks the run failed.
 *
 * The wire schema now says what a specialist may send; the limit is applied
 * afterwards, where the cost of an over-long title is an over-long title.
 */
export const TITLE_DISPLAY_LIMIT = 120;

/** One issue a specialist flags in the diff. */
export const Finding = z.object({
  file: z.string().describe('Repo-relative path of the file the issue is in'),
  line: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('1-based line in the new file, or null if not line-specific'),
  severity: z.enum(SEVERITIES),
  // Still bounded — these land in a database and on a page, so "no limit" is
  // not an option — but bounded well above where a model writes, so the cap
  // catches runaway output rather than ordinary verbosity.
  title: z.string().min(4).max(400).describe('One-line summary of the issue'),
  rationale: z.string().min(10).max(4000).describe('Why this is a problem, grounded in the diff'),
  suggestion: z.string().max(4000).nullable().describe('Concrete fix, or null if none'),
});
export type Finding = z.infer<typeof Finding>;

/** What each specialist agent returns (the structured-output contract). */
export const SpecialistOutput = z.object({
  findings: z.array(Finding).max(50),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutput>;

/** Cut a title to display length on a word boundary, once, after validation. */
export function truncateTitle(title: string, limit = TITLE_DISPLAY_LIMIT): string {
  if (title.length <= limit) return title;
  const cut = title.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > limit * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Apply the presentation rules a specialist's output has to satisfy before it
 * is stored or shown. Kept separate from parsing so that failing them costs
 * one field rather than the whole response.
 */
export function normaliseFinding(f: Finding): Finding {
  return { ...f, title: truncateTitle(f.title) };
}

export const RUN_STATUSES = [
  'reviewing',
  'awaiting_approval',
  'publishing',
  'done',
  'failed',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const DECISIONS = ['pending', 'approved', 'rejected'] as const;
export type Decision = (typeof DECISIONS)[number];

/**
 * Which stage a failed run died in.
 *
 * `failed` on its own records that a run died but never where, so resume had
 * nothing to branch on and sent every failure back through the review stage —
 * including publish failures, which came back looking like ordinary runs
 * awaiting approval.
 */
export const FAILED_STAGES = ['reviewing', 'publishing'] as const;
export type FailedStage = (typeof FAILED_STAGES)[number];

/** A finding as stored, with orchestration metadata. */
export interface StoredFinding extends Finding {
  id: string;
  runId: string;
  specialist: Specialist;
  dedupKey: string;
  decision: Decision;
  published: boolean;
}

export interface Run {
  id: string;
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  status: RunStatus;
  /** Display id of the model, e.g. claude-sonnet-4-6. */
  model: string;
  /** The key resume needs to reach the same model. Null on rows created before it was stored. */
  modelKey: string | null;
  /** The commit that was reviewed, so a resume can tell the branch moved. */
  headSha: string | null;
  failedStage: FailedStage | null;
  publishAttemptId: string | null;
  publishedCommentUrl: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stable identity for a finding, used to dedup across specialists and to make
 * re-runs idempotent. Two findings on the same file+line whose titles normalize
 * to the same key collapse into one.
 */
export function dedupKey(f: Pick<Finding, 'file' | 'line' | 'title'>): string {
  const title = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 6)
    .join(' ');
  return `${f.file}:${f.line ?? 0}:${title}`;
}
