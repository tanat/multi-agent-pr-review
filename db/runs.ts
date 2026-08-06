import { db } from './client';
import {
  dedupKey,
  type Decision,
  type Finding,
  type Run,
  type RunStatus,
  type Specialist,
  type StoredFinding,
} from '@/lib/schemas';

interface RunRow {
  id: string;
  pr_url: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  status: RunStatus;
  model: string;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRun(r: RunRow): Run {
  return {
    id: r.id,
    prUrl: r.pr_url,
    owner: r.owner,
    repo: r.repo,
    number: Number(r.number),
    title: r.title,
    status: r.status,
    model: r.model,
    error: r.error,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
  };
}

export async function createRun(args: {
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  title: string | null;
  model: string;
}): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    INSERT INTO runs (pr_url, owner, repo, number, title, model)
    VALUES (${args.prUrl}, ${args.owner}, ${args.repo}, ${args.number}, ${args.title}, ${args.model})
    RETURNING id
  `;
  return row.id;
}

export async function getRun(id: string): Promise<Run | null> {
  const rows = await db<RunRow[]>`SELECT * FROM runs WHERE id = ${id}`;
  return rows.length ? toRun(rows[0]) : null;
}

export async function listRuns(limit = 50): Promise<Run[]> {
  const rows = await db<RunRow[]>`SELECT * FROM runs ORDER BY created_at DESC LIMIT ${limit}`;
  return rows.map(toRun);
}

export async function setStatus(id: string, status: RunStatus, error: string | null = null): Promise<void> {
  await db`UPDATE runs SET status = ${status}, error = ${error} WHERE id = ${id}`;
}

/** Specialists that have finished for this run (tracked in meta so a zero-finding run still counts as done). */
export async function getCompletedSpecialists(id: string): Promise<Specialist[]> {
  const [row] = await db<{ completed: Specialist[] | null }[]>`
    SELECT meta->'completed' AS completed FROM runs WHERE id = ${id}
  `;
  return row?.completed ?? [];
}

export async function markSpecialistComplete(id: string, specialist: Specialist): Promise<void> {
  // Append to meta.completed idempotently (jsonb array union by re-reading is
  // overkill; ON CONFLICT on findings already makes inserts idempotent, and a
  // duplicate entry here is harmless because callers dedup with a Set).
  await db`
    UPDATE runs
    SET meta = jsonb_set(
      meta,
      '{completed}',
      COALESCE(meta->'completed', '[]'::jsonb) || ${JSON.stringify([specialist])}::jsonb
    )
    WHERE id = ${id}
  `;
}

interface FindingRow {
  id: string;
  run_id: string;
  specialist: Specialist;
  file: string;
  line: number | null;
  severity: StoredFinding['severity'];
  title: string;
  rationale: string;
  suggestion: string | null;
  dedup_key: string;
  decision: Decision;
  published: boolean;
}

function toFinding(r: FindingRow): StoredFinding {
  return {
    id: r.id,
    runId: r.run_id,
    specialist: r.specialist,
    file: r.file,
    line: r.line,
    severity: r.severity,
    title: r.title,
    rationale: r.rationale,
    suggestion: r.suggestion,
    dedupKey: r.dedup_key,
    decision: r.decision,
    published: r.published,
  };
}

/** Insert a specialist's findings idempotently (ON CONFLICT on the dedup key). */
export async function insertFindings(
  runId: string,
  specialist: Specialist,
  findings: Finding[],
): Promise<void> {
  if (findings.length === 0) return;
  const rows = findings.map((f) => ({
    run_id: runId,
    specialist,
    file: f.file,
    line: f.line,
    severity: f.severity,
    title: f.title,
    rationale: f.rationale,
    suggestion: f.suggestion,
    dedup_key: dedupKey(f),
  }));
  await db`
    INSERT INTO findings ${db(
      rows,
      'run_id',
      'specialist',
      'file',
      'line',
      'severity',
      'title',
      'rationale',
      'suggestion',
      'dedup_key',
    )}
    ON CONFLICT (run_id, dedup_key) DO NOTHING
  `;
}

export async function getFindings(runId: string): Promise<StoredFinding[]> {
  const rows = await db<FindingRow[]>`SELECT * FROM findings WHERE run_id = ${runId}`;
  const rank: Record<StoredFinding['severity'], number> = { critical: 0, high: 1, medium: 2, low: 3 };
  return rows
    .map(toFinding)
    .sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        a.file.localeCompare(b.file) ||
        (a.line ?? 0) - (b.line ?? 0),
    );
}

/**
 * Set one finding's decision, scoped to its run.
 *
 * The run id is not decoration. Without it the statement is "update whichever
 * finding carries this id", so a request aimed at run A can flip a finding that
 * belongs to run B — the route already knows which run it is acting on and used
 * to throw that knowledge away. Returns false when nothing matched, so the
 * caller can answer 404 instead of reporting success for a write that did not
 * happen.
 */
export async function setDecision(
  runId: string,
  findingId: string,
  decision: Decision,
): Promise<boolean> {
  const rows = await db<{ id: string }[]>`
    UPDATE findings SET decision = ${decision}
    WHERE id = ${findingId} AND run_id = ${runId}
    RETURNING id
  `;
  return rows.length > 0;
}

/** Bulk-set decisions for one run (e.g. approve-all). */
export async function setAllDecisions(runId: string, decision: Decision): Promise<void> {
  await db`UPDATE findings SET decision = ${decision} WHERE run_id = ${runId}`;
}

export async function markPublished(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db`UPDATE findings SET published = true WHERE id IN ${db(ids)}`;
}
