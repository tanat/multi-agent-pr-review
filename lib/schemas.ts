import { z } from 'zod';

export const SPECIALISTS = ['security', 'correctness', 'tests', 'style'] as const;
export type Specialist = (typeof SPECIALISTS)[number];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

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
  title: z.string().min(4).max(120).describe('One-line summary of the issue'),
  rationale: z.string().min(10).describe('Why this is a problem, grounded in the diff'),
  suggestion: z.string().nullable().describe('Concrete fix, or null if none'),
});
export type Finding = z.infer<typeof Finding>;

/** What each specialist agent returns (the structured-output contract). */
export const SpecialistOutput = z.object({
  findings: z.array(Finding).max(20),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutput>;

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
  model: string;
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
