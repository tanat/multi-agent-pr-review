import { SPECIALISTS, type Finding, type Specialist } from '@/lib/schemas';
import type { GoldIssue } from './fixtures';

/**
 * Scoring a review is a matching problem: which of the findings a specialist
 * emitted correspond to the defects we planted?
 *
 * The old answer was "same file, line within ±3". That cannot distinguish a
 * caught SQL injection from a remark about variable naming three lines away,
 * which is why every specialist reported a recall of 1.000 — the fixtures
 * already carried a description of each planted defect and nothing read it.
 *
 * A finding now has to land in the right place AND say something about the
 * right defect. "Says something about" is decided by term overlap against
 * signals written per gold issue, which keeps the scorer deterministic and free
 * to re-run. A model judge would read intent better; it would also cost a call
 * per pair and make the number unreproducible, and the errors of a judge from
 * the same family as the reviewers correlate with the errors being measured.
 * The trade is recorded in evals/README.md.
 */

/**
 * Bumped when the definition of a true positive changes. Recorded on every
 * results.json row, because a recall measured by "same file and line" and one
 * measured by "names the defect" are different quantities wearing the same
 * name, and nothing in the old rows said which was which.
 */
export const MATCHER_VERSION = 'v2.0.0-concept' as const;

/** How a finding was tied to a gold issue. */
export type MatchKind = 'signal' | 'none';

/** Line distance still allowed once the concept matches. */
export const LINE_TOLERANCE = 3;

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in', 'on', 'at', 'for',
  'and', 'or', 'not', 'this', 'that', 'these', 'those', 'it', 'its', 'with', 'without', 'by',
  'from', 'as', 'if', 'then', 'than', 'so', 'but', 'can', 'will', 'would', 'should', 'could',
  'has', 'have', 'had', 'does', 'do', 'did', 'no', 'any', 'all', 'you', 'your', 'we', 'they',
]);

export function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

/** The words a specialist actually wrote about a finding. */
export function findingText(f: Finding): string {
  return `${f.title} ${f.rationale} ${f.suggestion ?? ''}`;
}

/**
 * Whether a finding is talking about a gold issue.
 *
 * A signal is a phrase; a multi-word signal has to have all of its words
 * present, so "race condition" does not fire on a sentence that merely says
 * "condition". One signal is enough — a specialist that names the defect once
 * has found it, and demanding several would penalise terse writing rather than
 * wrong answers.
 */
export function matchesConcept(f: Finding, g: GoldIssue): boolean {
  const words = tokens(findingText(f));
  if (words.size === 0) return false;
  const hit = (phrase: string) => {
    const needed = tokens(phrase);
    return needed.size > 0 && [...needed].every((w) => words.has(w));
  };
  // An anti-signal is a veto, not a tie-break. Two defects can sit on the same
  // line — a regex that is both injectable and catastrophically backtracking —
  // and a finding that names one of them has found that one. Without the veto
  // it would be credited for whichever gold entry the assignment reached first.
  if (g.antiSignals?.some(hit)) return false;
  return g.signals.some(hit);
}

/** Whether a finding is pointing at the right place. */
export function matchesLocation(f: Finding, g: GoldIssue): boolean {
  if (f.file !== g.file) return false;
  if (g.line == null) return true; // file-level gold
  if (f.line == null) return false;
  return Math.abs(f.line - g.line) <= LINE_TOLERANCE;
}

export interface SpecialistScore {
  specialist: Specialist;
  goldCount: number;
  foundCount: number;
  truePositives: number;
  /**
   * `null` rather than a number when the denominator is empty: a lens with no
   * gold in a fixture has no recall, and a lens that emitted nothing has no
   * precision. The old code returned 1.00 for both, which made silence the
   * dominant strategy and let empty cells inflate the average.
   */
  precision: number | null;
  recall: number | null;
  f1: number | null;
  /** Planted defects this lens did not name — the useful half of a bad score. */
  missedConcepts: string[];
  /** Findings that landed on a gold location without describing the defect. */
  nearMisses: number;
}

function rates(truePositives: number, found: number, gold: number) {
  const precision = found > 0 ? truePositives / found : null;
  const recall = gold > 0 ? truePositives / gold : null;
  const f1 =
    precision != null && recall != null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return { precision, recall, f1 };
}

interface Pair {
  findingIdx: number;
  goldIdx: number;
  lineDistance: number;
}

/**
 * Assign findings to gold issues, best pairs first.
 *
 * The old loop walked the findings in emission order and took the first gold
 * each one happened to fit, so findings [14, 11] against gold [11, 16] scored
 * one match instead of two — the finding at 14 consumed the gold at 11 before
 * the finding at 11 was considered. Sorting candidate pairs by how close they
 * are before assigning removes that ordering dependence without needing a full
 * optimal assignment at these sizes.
 */
function assign(findings: Finding[], gold: GoldIssue[]): Pair[] {
  const candidates: Pair[] = [];
  for (let fi = 0; fi < findings.length; fi++) {
    for (let gi = 0; gi < gold.length; gi++) {
      if (!matchesLocation(findings[fi], gold[gi])) continue;
      if (!matchesConcept(findings[fi], gold[gi])) continue;
      const lineDistance =
        gold[gi].line == null || findings[fi].line == null
          ? 0
          : Math.abs(findings[fi].line! - gold[gi].line!);
      candidates.push({ findingIdx: fi, goldIdx: gi, lineDistance });
    }
  }
  candidates.sort((a, b) => a.lineDistance - b.lineDistance);

  const usedFindings = new Set<number>();
  const usedGold = new Set<number>();
  const assigned: Pair[] = [];
  for (const c of candidates) {
    if (usedFindings.has(c.findingIdx) || usedGold.has(c.goldIdx)) continue;
    usedFindings.add(c.findingIdx);
    usedGold.add(c.goldIdx);
    assigned.push(c);
  }
  return assigned;
}

/** Score one fixture: per-specialist precision/recall against the gold set. */
export function scoreFixture(
  findingsBySpecialist: Record<Specialist, Finding[]>,
  gold: GoldIssue[],
): SpecialistScore[] {
  return SPECIALISTS.map((s) => {
    const found = findingsBySpecialist[s] ?? [];
    const goldForS = gold.filter((g) => g.specialist === s);
    const assigned = assign(found, goldForS);
    const matchedGold = new Set(assigned.map((p) => p.goldIdx));

    // Findings sitting on a planted defect that describe something else. Worth
    // counting separately: it is the difference between a lens that missed the
    // bug and one that looked straight at it and reported a different problem.
    const nearMisses = found.filter(
      (f, fi) =>
        !assigned.some((p) => p.findingIdx === fi) && goldForS.some((g) => matchesLocation(f, g)),
    ).length;

    return {
      specialist: s,
      goldCount: goldForS.length,
      foundCount: found.length,
      truePositives: matchedGold.size,
      missedConcepts: goldForS.filter((_, gi) => !matchedGold.has(gi)).map((g) => g.concept),
      nearMisses,
      ...rates(matchedGold.size, found.length, goldForS.length),
    };
  });
}

export interface Aggregate {
  perSpecialist: SpecialistScore[];
  overall: {
    goldCount: number;
    foundCount: number;
    truePositives: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  /** Concepts no lens caught, most-missed first — where the review is blind. */
  topMissedConcepts: { concept: string; misses: number }[];
  /** Wilson 95% interval on overall recall; the honest width of the claim. */
  recallInterval: { low: number; high: number } | null;
}

/**
 * Wilson score interval.
 *
 * A recall of 8/8 is not 1.00 with any confidence — on eight observations the
 * interval runs down to roughly 0.63. Printing the interval next to the rate is
 * what stops a small corpus from reading like a strong result.
 */
export function wilson(successes: number, trials: number, z = 1.96): { low: number; high: number } | null {
  if (trials === 0) return null;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = p + (z * z) / (2 * trials);
  const spread = z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials));
  return {
    low: Math.max(0, (centre - spread) / denom),
    high: Math.min(1, (centre + spread) / denom),
  };
}

/** Micro-average across all fixtures (sum the counts, then compute the rates). */
export function aggregate(allScores: SpecialistScore[][]): Aggregate {
  const flat = allScores.flat();

  const perSpecialist = SPECIALISTS.map((s) => {
    const rows = flat.filter((r) => r.specialist === s);
    const gold = rows.reduce((a, r) => a + r.goldCount, 0);
    const found = rows.reduce((a, r) => a + r.foundCount, 0);
    const tp = rows.reduce((a, r) => a + r.truePositives, 0);
    return {
      specialist: s,
      goldCount: gold,
      foundCount: found,
      truePositives: tp,
      missedConcepts: rows.flatMap((r) => r.missedConcepts),
      nearMisses: rows.reduce((a, r) => a + r.nearMisses, 0),
      ...rates(tp, found, gold),
    };
  });

  const gold = perSpecialist.reduce((a, r) => a + r.goldCount, 0);
  const found = perSpecialist.reduce((a, r) => a + r.foundCount, 0);
  const tp = perSpecialist.reduce((a, r) => a + r.truePositives, 0);

  const misses = new Map<string, number>();
  for (const r of perSpecialist) {
    for (const c of r.missedConcepts) misses.set(c, (misses.get(c) ?? 0) + 1);
  }

  return {
    perSpecialist,
    overall: { goldCount: gold, foundCount: found, truePositives: tp, ...rates(tp, found, gold) },
    topMissedConcepts: [...misses.entries()]
      .map(([concept, m]) => ({ concept, misses: m }))
      .sort((a, b) => b.misses - a.misses),
    recallInterval: wilson(tp, gold),
  };
}
