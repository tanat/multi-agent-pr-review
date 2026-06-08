import { SPECIALISTS, type Finding, type Specialist } from '@/lib/schemas';
import type { GoldIssue } from './fixtures';

/** A finding matches a gold issue if same file and within this many lines. */
const LINE_TOLERANCE = 3;

export interface SpecialistScore {
  specialist: Specialist;
  goldCount: number;
  foundCount: number;
  truePositives: number;
  precision: number;
  recall: number;
  f1: number;
}

function matches(f: Finding, g: GoldIssue): boolean {
  if (f.file !== g.file) return false;
  if (g.line == null) return true; // file-level gold
  if (f.line == null) return false;
  return Math.abs(f.line - g.line) <= LINE_TOLERANCE;
}

function prf(truePositives: number, found: number, gold: number): Pick<SpecialistScore, 'precision' | 'recall' | 'f1'> {
  const precision = found ? truePositives / found : gold === 0 ? 1 : 0;
  const recall = gold ? truePositives / gold : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/** Score one fixture: per-specialist precision/recall against the gold set. */
export function scoreFixture(
  findingsBySpecialist: Record<Specialist, Finding[]>,
  gold: GoldIssue[],
): SpecialistScore[] {
  return SPECIALISTS.map((s) => {
    const found = findingsBySpecialist[s] ?? [];
    const goldForS = gold.filter((g) => g.specialist === s);
    const matchedGold = new Set<number>();
    for (const f of found) {
      const gi = goldForS.findIndex((g, idx) => !matchedGold.has(idx) && matches(f, g));
      if (gi >= 0) matchedGold.add(gi);
    }
    const truePositives = matchedGold.size;
    return {
      specialist: s,
      goldCount: goldForS.length,
      foundCount: found.length,
      truePositives,
      ...prf(truePositives, found.length, goldForS.length),
    };
  });
}

export interface Aggregate {
  perSpecialist: SpecialistScore[];
  overall: { goldCount: number; foundCount: number; truePositives: number } & Pick<
    SpecialistScore,
    'precision' | 'recall' | 'f1'
  >;
}

/** Micro-average across all fixtures (sum the counts, then compute P/R/F1). */
export function aggregate(allScores: SpecialistScore[][]): Aggregate {
  const perSpecialist = SPECIALISTS.map((s) => {
    const rows = allScores.flat().filter((r) => r.specialist === s);
    const gold = rows.reduce((a, r) => a + r.goldCount, 0);
    const found = rows.reduce((a, r) => a + r.foundCount, 0);
    const tp = rows.reduce((a, r) => a + r.truePositives, 0);
    return { specialist: s, goldCount: gold, foundCount: found, truePositives: tp, ...prf(tp, found, gold) };
  });
  const gold = perSpecialist.reduce((a, r) => a + r.goldCount, 0);
  const found = perSpecialist.reduce((a, r) => a + r.foundCount, 0);
  const tp = perSpecialist.reduce((a, r) => a + r.truePositives, 0);
  return { perSpecialist, overall: { goldCount: gold, foundCount: found, truePositives: tp, ...prf(tp, found, gold) } };
}
