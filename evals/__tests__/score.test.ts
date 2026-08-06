import { describe, expect, it } from 'vitest';
import { aggregate, scoreFixture } from '../score';
import type { GoldIssue } from '../fixtures';
import type { Finding, Specialist } from '@/lib/schemas';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.ts',
    line: 10,
    severity: 'high',
    title: 'Something is wrong here',
    rationale: 'Because of the change on this line.',
    suggestion: null,
    ...over,
  };
}

function gold(over: Partial<GoldIssue> = {}): GoldIssue {
  return {
    specialist: 'security',
    file: 'src/a.ts',
    line: 10,
    severity: 'critical',
    note: 'SQL injection via string concatenation of req.query.id',
    ...over,
  };
}

function bySpecialist(partial: Partial<Record<Specialist, Finding[]>>): Record<Specialist, Finding[]> {
  return { security: [], correctness: [], tests: [], style: [], ...partial };
}

function forSpecialist(scores: ReturnType<typeof scoreFixture>, s: Specialist) {
  return scores.find((r) => r.specialist === s)!;
}

describe('matching', () => {
  it('counts a finding on the same file and line', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding()] }), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 1, precision: 1, recall: 1 });
  });

  it('allows the reported line to be off by up to three', () => {
    for (const line of [7, 10, 13]) {
      const scores = scoreFixture(bySpecialist({ security: [finding({ line })] }), [gold()]);
      expect(forSpecialist(scores, 'security').truePositives, `line ${line}`).toBe(1);
    }
    const miss = scoreFixture(bySpecialist({ security: [finding({ line: 14 })] }), [gold()]);
    expect(forSpecialist(miss, 'security').truePositives).toBe(0);
  });

  it('never matches across files', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding({ file: 'src/b.ts' })] }), [gold()]);
    expect(forSpecialist(scores, 'security').truePositives).toBe(0);
  });

  it('never credits one specialist for another specialist s gold', () => {
    const scores = scoreFixture(bySpecialist({ correctness: [finding()] }), [gold({ specialist: 'security' })]);
    expect(forSpecialist(scores, 'correctness').truePositives).toBe(0);
    expect(forSpecialist(scores, 'security')).toMatchObject({ goldCount: 1, truePositives: 0, recall: 0 });
  });

  it('lets file-level gold be satisfied by a finding anywhere in the file', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding({ line: 999 })] }), [gold({ line: null })]);
    expect(forSpecialist(scores, 'security').truePositives).toBe(1);
  });

  it('does not let a line-less finding satisfy line-specific gold', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding({ line: null })] }), [gold({ line: 10 })]);
    expect(forSpecialist(scores, 'security').truePositives).toBe(0);
  });

  it('matches each gold issue at most once', () => {
    // Three findings piled on one planted bug is one true positive and two
    // false positives, not three true positives.
    const scores = scoreFixture(
      bySpecialist({ security: [finding(), finding({ line: 11 }), finding({ line: 12 })] }),
      [gold()],
    );
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 1, foundCount: 3 });
    expect(forSpecialist(scores, 'security').precision).toBeCloseTo(1 / 3);
  });
});

describe('what the matcher cannot see', () => {
  it('CANNOT TELL whether the finding is about the planted defect at all', () => {
    // The gold entry says "SQL injection". This finding says the variable has a
    // bad name. Same file, same line, so it scores as a true positive and the
    // planted bug is recorded as caught.
    //
    // The information needed to reject it is already in the fixture — gold.note
    // describes the actual defect — and the scorer never looks at it. This is
    // the single reason recall reads 1.000 for all four specialists in
    // results.json. Phase 1 makes this test expect 0.
    const irrelevant = finding({ title: 'Variable name `id` is not descriptive' });
    const scores = scoreFixture(bySpecialist({ security: [irrelevant] }), [gold()]);
    expect(forSpecialist(scores, 'security').truePositives).toBe(1);
  });

  it('rewards carpet-bombing a small diff', () => {
    // A specialist that flags every line of a twenty-line file is guaranteed
    // full recall. Precision drops, but evals/README.md pre-excuses precision as
    // "a lower bound, not a verdict" — so nothing in the report can go red.
    const spray = Array.from({ length: 20 }, (_, i) => finding({ line: i + 1 }));
    const scores = scoreFixture(bySpecialist({ security: spray }), [
      gold({ line: 3 }),
      gold({ line: 11 }),
      gold({ line: 18 }),
    ]);
    expect(forSpecialist(scores, 'security').recall).toBe(1);
  });
});

describe('precision/recall edge cases', () => {
  it('scores a specialist with no gold and no findings as perfect, not zero', () => {
    const scores = scoreFixture(bySpecialist({}), [gold({ specialist: 'security' })]);
    expect(forSpecialist(scores, 'style')).toMatchObject({ goldCount: 0, foundCount: 0, precision: 1, recall: 1 });
  });

  it('scores silence against existing gold as zero recall', () => {
    const scores = scoreFixture(bySpecialist({}), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ recall: 0, f1: 0 });
  });

  it('scores noise against no gold as zero precision', () => {
    const scores = scoreFixture(bySpecialist({ style: [finding()] }), [gold({ specialist: 'security' })]);
    expect(forSpecialist(scores, 'style')).toMatchObject({ precision: 0, recall: 1 });
  });
});

describe('aggregate', () => {
  it('micro-averages by summing counts, not by averaging rates', () => {
    // Fixture A: 1 of 1 caught. Fixture B: 0 of 3 caught, 6 findings.
    // Averaging the two recalls would give 0.5; the honest micro-average is 1/4.
    const a = scoreFixture(bySpecialist({ security: [finding()] }), [gold()]);
    const b = scoreFixture(
      bySpecialist({ security: Array.from({ length: 6 }, () => finding({ file: 'other.ts' })) }),
      [gold({ line: 40 }), gold({ line: 60 }), gold({ line: 80 })],
    );
    const agg = aggregate([a, b]);
    const sec = agg.perSpecialist.find((r) => r.specialist === 'security')!;
    expect(sec).toMatchObject({ goldCount: 4, foundCount: 7, truePositives: 1 });
    expect(sec.recall).toBeCloseTo(0.25);
    expect(agg.overall).toMatchObject({ goldCount: 4, foundCount: 7, truePositives: 1 });
  });

  it('reports every specialist even when one never fires', () => {
    const agg = aggregate([scoreFixture(bySpecialist({ security: [finding()] }), [gold()])]);
    expect(agg.perSpecialist.map((r) => r.specialist)).toEqual(['security', 'correctness', 'tests', 'style']);
  });
});
