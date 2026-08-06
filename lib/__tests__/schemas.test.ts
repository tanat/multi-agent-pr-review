import { describe, expect, it } from 'vitest';
import { Finding, SpecialistOutput, dedupKey } from '../schemas';

describe('Finding schema', () => {
  const valid = {
    file: 'src/a.ts',
    line: 12,
    severity: 'high' as const,
    title: 'Off-by-one in the loop bound',
    rationale: 'The loop uses <= against length, so it reads one past the end.',
    suggestion: 'Use < instead of <=.',
  };

  it('accepts a well-formed finding', () => {
    expect(Finding.parse(valid)).toEqual(valid);
  });

  it('allows a file-level finding with no line', () => {
    expect(Finding.parse({ ...valid, line: null }).line).toBeNull();
  });

  it('rejects a line number that cannot exist', () => {
    expect(() => Finding.parse({ ...valid, line: 0 })).toThrow();
    expect(() => Finding.parse({ ...valid, line: -3 })).toThrow();
    expect(() => Finding.parse({ ...valid, line: 1.5 })).toThrow();
  });

  it('rejects a title too short to be a summary or too long to scan', () => {
    expect(() => Finding.parse({ ...valid, title: 'bug' })).toThrow();
    expect(() => Finding.parse({ ...valid, title: 'x'.repeat(121) })).toThrow();
  });

  it('caps a specialist at 20 findings', () => {
    const twenty = Array.from({ length: 20 }, () => valid);
    expect(SpecialistOutput.parse({ findings: twenty }).findings).toHaveLength(20);
    expect(() => SpecialistOutput.parse({ findings: [...twenty, valid] })).toThrow();
  });
});

describe('dedupKey', () => {
  it('is stable across punctuation and case', () => {
    const a = dedupKey({ file: 'src/a.ts', line: 5, title: 'SQL Injection via string concatenation' });
    const b = dedupKey({ file: 'src/a.ts', line: 5, title: 'sql injection, via  string-concatenation' });
    expect(a).toBe(b);
  });

  it('keeps only the first six words of the title', () => {
    const key = dedupKey({
      file: 'a.ts',
      line: 1,
      title: 'one two three four five six seven eight',
    });
    expect(key).toBe('a.ts:1:one two three four five six');
  });

  it('files a line-less finding under line 0', () => {
    expect(dedupKey({ file: 'a.ts', line: null, title: 'Some file level issue' })).toBe(
      'a.ts:0:some file level issue',
    );
  });

  // --- The two ways the current key fails to dedup. Pinned as tests because
  // phase 2 replaces it, and the diff should show these flipping.

  it('MISSES the same defect described in different words', () => {
    // Both specialists found the identical SQL injection on the identical line.
    // Different wording, different key, two rows in the database, two things for
    // the human to triage — and the fact that two independent lenses agreed,
    // which is the strongest precision signal the system produces, is lost.
    const security = dedupKey({ file: 'a.ts', line: 16, title: 'SQL injection via string concatenation' });
    const correctness = dedupKey({ file: 'a.ts', line: 16, title: 'Unsanitised query parameter interpolated into SQL' });
    expect(security).not.toBe(correctness);
  });

  it('MISSES the same defect when the reported line is off by one', () => {
    // Line numbers in a model-reported finding are approximate — the eval scorer
    // itself allows ±3 for exactly this reason. The dedup key does not, so a
    // one-line disagreement defeats it even when the titles match verbatim.
    const a = dedupKey({ file: 'a.ts', line: 16, title: 'SQL injection via string concatenation' });
    const b = dedupKey({ file: 'a.ts', line: 17, title: 'SQL injection via string concatenation' });
    expect(a).not.toBe(b);
  });
});
