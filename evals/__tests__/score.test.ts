import { describe, expect, it } from 'vitest';
import { LINE_TOLERANCE, aggregate, matchesConcept, scoreFixture, wilson } from '../score';
import type { GoldIssue } from '../fixtures';
import type { Finding, Specialist } from '@/lib/schemas';

function finding(over: Partial<Finding> = {}): Finding {
  return {
    file: 'src/a.ts',
    line: 10,
    severity: 'high',
    title: 'SQL injection in the user lookup',
    rationale: 'req.query.id is concatenated straight into the query string.',
    suggestion: null,
    ...over,
  };
}

function gold(over: Partial<GoldIssue> = {}): GoldIssue {
  return {
    specialist: 'security',
    concept: 'sql_injection',
    file: 'src/a.ts',
    line: 10,
    severity: 'critical',
    primed: true,
    signals: ['sql injection', 'parameterised query'],
    note: 'SQL injection via string concatenation',
    ...over,
  };
}

function bySpecialist(partial: Partial<Record<Specialist, Finding[]>>): Record<Specialist, Finding[]> {
  return { security: [], correctness: [], tests: [], style: [], ...partial };
}

function forSpecialist(scores: ReturnType<typeof scoreFixture>, s: Specialist) {
  return scores.find((r) => r.specialist === s)!;
}

describe('matchesConcept', () => {
  it('fires when the finding names the defect', () => {
    expect(matchesConcept(finding(), gold())).toBe(true);
  });

  it('needs every word of a phrase, not just one', () => {
    // "condition" alone must not satisfy "race condition", or half the signals
    // in the corpus would fire on ordinary prose.
    const g = gold({ signals: ['race condition'] });
    expect(matchesConcept(finding({ title: 'The condition here is wrong', rationale: 'x' }), g)).toBe(false);
    expect(matchesConcept(finding({ title: 'Race condition on the counter', rationale: 'x' }), g)).toBe(true);
  });

  it('ignores word order and punctuation', () => {
    expect(
      matchesConcept(finding({ title: 'Injection (SQL) is possible here', rationale: 'x' }), gold()),
    ).toBe(true);
  });

  it('is vetoed by an anti-signal even when a signal also fires', () => {
    // Two defects can share a line. A finding that names the other one has
    // found the other one, and must not be credited for this gold entry.
    const g = gold({
      concept: 'regex_injection',
      signals: ['regex injection', 'unvalidated input'],
      antiSignals: ['catastrophic backtracking'],
    });
    const both = finding({
      title: 'Regex injection and catastrophic backtracking',
      rationale: 'user input reaches the pattern',
    });
    expect(matchesConcept(both, g)).toBe(false);
  });

  it('reads the suggestion as well as the title and rationale', () => {
    expect(
      matchesConcept(
        finding({ title: 'Query built by hand', rationale: 'see below', suggestion: 'Use a parameterised query.' }),
        gold(),
      ),
    ).toBe(true);
  });
});

describe('a finding must be in the right place AND about the right defect', () => {
  it('counts a finding that satisfies both', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding()] }), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 1, precision: 1, recall: 1 });
  });

  it('REJECTS a finding on the right line that describes something else', () => {
    // This is the case the old matcher could not see, and the single reason
    // recall read 1.000 for every specialist. A remark about naming, sitting on
    // the line where a SQL injection was planted, is not a caught injection.
    const irrelevant = finding({
      title: 'Variable name `id` is not descriptive',
      rationale: 'A longer name would read better here.',
    });
    const scores = scoreFixture(bySpecialist({ security: [irrelevant] }), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 0, recall: 0, nearMisses: 1 });
  });

  it('rejects the right defect reported in the wrong file', () => {
    const scores = scoreFixture(bySpecialist({ security: [finding({ file: 'src/b.ts' })] }), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 0, nearMisses: 0 });
  });

  it('still allows the reported line to be off by the tolerance', () => {
    for (const line of [10 - LINE_TOLERANCE, 10, 10 + LINE_TOLERANCE]) {
      const scores = scoreFixture(bySpecialist({ security: [finding({ line })] }), [gold()]);
      expect(forSpecialist(scores, 'security').truePositives, `line ${line}`).toBe(1);
    }
    const miss = scoreFixture(bySpecialist({ security: [finding({ line: 10 + LINE_TOLERANCE + 1 })] }), [gold()]);
    expect(forSpecialist(miss, 'security').truePositives).toBe(0);
  });

  it('no longer rewards carpet-bombing a small diff', () => {
    // Twenty findings, one per line, none of which names the defect. The old
    // matcher gave this full recall.
    const spray = Array.from({ length: 20 }, (_, i) =>
      finding({ line: i + 1, title: 'This line could be clearer', rationale: 'Consider rewriting it.' }),
    );
    const scores = scoreFixture(bySpecialist({ security: spray }), [gold({ line: 3 }), gold({ line: 11 })]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 0, recall: 0 });
  });

  it('names what was missed instead of only scoring it', () => {
    const scores = scoreFixture(bySpecialist({ security: [] }), [
      gold({ concept: 'sql_injection' }),
      gold({ concept: 'committed_secret', signals: ['hardcoded secret'] }),
    ]);
    expect(forSpecialist(scores, 'security').missedConcepts).toEqual(['sql_injection', 'committed_secret']);
  });
});

describe('assignment', () => {
  it('matches each gold issue at most once', () => {
    const scores = scoreFixture(
      bySpecialist({ security: [finding(), finding({ line: 11 }), finding({ line: 12 })] }),
      [gold()],
    );
    expect(forSpecialist(scores, 'security')).toMatchObject({ truePositives: 1, foundCount: 3 });
    expect(forSpecialist(scores, 'security').precision).toBeCloseTo(1 / 3);
  });

  it('does not lose a pair to the order the findings arrived in', () => {
    // Gold at 11 and 16; findings at 14 and 11. Walking the findings in order,
    // the one at 14 takes the gold at 11 (distance 3, within tolerance) and the
    // finding at 11 is left with nothing — one match instead of two. Sorting
    // candidates by distance first gives 11→11 and 14→16.
    const g = [gold({ line: 11, concept: 'a' }), gold({ line: 16, concept: 'b' })];
    const f = [finding({ line: 14 }), finding({ line: 11 })];
    expect(forSpecialist(scoreFixture(bySpecialist({ security: f }), g), 'security').truePositives).toBe(2);
  });

  it('never credits one specialist for another specialist s gold', () => {
    const scores = scoreFixture(bySpecialist({ correctness: [finding()] }), [gold({ specialist: 'security' })]);
    expect(forSpecialist(scores, 'correctness').truePositives).toBe(0);
    expect(forSpecialist(scores, 'security')).toMatchObject({ goldCount: 1, truePositives: 0, recall: 0 });
  });

  it('lets file-level gold be satisfied anywhere in the file', () => {
    const g = gold({ line: null, concept: 'untested', signals: ['no test'] });
    const f = finding({ line: 999, title: 'There is no test for this handler', rationale: 'nothing covers it' });
    expect(forSpecialist(scoreFixture(bySpecialist({ security: [f] }), [g]), 'security').truePositives).toBe(1);
  });
});

describe('empty denominators are absent, not perfect', () => {
  it('gives a lens with no gold and no findings no rates at all', () => {
    // Returning 1.00 here made silence the dominant strategy and let empty gold
    // cells inflate the average — which is what made the style and tests
    // precision numbers unreadable.
    const scores = scoreFixture(bySpecialist({}), [gold({ specialist: 'security' })]);
    expect(forSpecialist(scores, 'style')).toMatchObject({
      goldCount: 0,
      foundCount: 0,
      precision: null,
      recall: null,
      f1: null,
    });
  });

  it('scores silence against existing gold as zero recall and no precision', () => {
    const scores = scoreFixture(bySpecialist({}), [gold()]);
    expect(forSpecialist(scores, 'security')).toMatchObject({ recall: 0, precision: null, f1: null });
  });

  it('scores noise on a clean diff as zero precision and no recall', () => {
    const scores = scoreFixture(bySpecialist({ style: [finding()] }), []);
    expect(forSpecialist(scores, 'style')).toMatchObject({ precision: 0, recall: null });
  });
});

describe('aggregate', () => {
  it('micro-averages by summing counts, not by averaging rates', () => {
    const a = scoreFixture(bySpecialist({ security: [finding()] }), [gold()]);
    const b = scoreFixture(
      bySpecialist({ security: Array.from({ length: 6 }, () => finding({ file: 'other.ts' })) }),
      [gold({ line: 40 }), gold({ line: 60 }), gold({ line: 80 })],
    );
    const agg = aggregate([a, b]);
    const sec = agg.perSpecialist.find((r) => r.specialist === 'security')!;
    expect(sec).toMatchObject({ goldCount: 4, foundCount: 7, truePositives: 1 });
    expect(sec.recall).toBeCloseTo(0.25);
  });

  it('ranks what the whole review missed', () => {
    const one = scoreFixture(bySpecialist({}), [gold({ concept: 'sql_injection' })]);
    const two = scoreFixture(bySpecialist({}), [gold({ concept: 'sql_injection' }), gold({ concept: 'xss' })]);
    expect(aggregate([one, two]).topMissedConcepts[0]).toEqual({ concept: 'sql_injection', misses: 2 });
  });

  it('reports every specialist even when one never fires', () => {
    const agg = aggregate([scoreFixture(bySpecialist({ security: [finding()] }), [gold()])]);
    expect(agg.perSpecialist.map((r) => r.specialist)).toEqual(['security', 'correctness', 'tests', 'style']);
  });
});

describe('wilson', () => {
  it('refuses to call 8 out of 8 a certainty', () => {
    // The headline the README currently leads with is "Recall 1.00 (8/8)". On
    // eight observations the interval reaches down past 0.6, which is the
    // difference between a result and an anecdote.
    const i = wilson(8, 8)!;
    expect(i.high).toBe(1);
    expect(i.low).toBeLessThan(0.7);
  });

  it('narrows as the corpus grows', () => {
    expect(wilson(80, 80)!.low).toBeGreaterThan(wilson(8, 8)!.low);
  });

  it('has no interval without observations', () => {
    expect(wilson(0, 0)).toBeNull();
  });
});
