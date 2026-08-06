import { describe, expect, it } from 'vitest';
import { InvalidPrUrlError, MAX_PATCH_CHARS, parsePrUrl, renderDiff, type PrContext } from '../github';

describe('parsePrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrUrl('https://github.com/sindresorhus/p-map/pull/77')).toEqual({
      owner: 'sindresorhus',
      repo: 'p-map',
      number: 77,
    });
  });

  it('tolerates the suffixes GitHub actually puts in the address bar', () => {
    // Every one of these is what you get from copying the URL mid-review.
    for (const url of [
      'https://github.com/o/r/pull/77/files',
      'https://github.com/o/r/pull/77#discussion_r123',
      'https://github.com/o/r/pull/77?w=1',
      'http://github.com/o/r/pull/77',
      'https://GitHub.com/o/r/PULL/77',
    ]) {
      expect(parsePrUrl(url), url).toMatchObject({ owner: 'o', repo: 'r', number: 77 });
    }
  });

  it('rejects things that are not PR URLs', () => {
    for (const url of [
      'https://github.com/o/r',
      'https://github.com/o/r/issues/77',
      'https://github.com/o/r/pulls/77',
      'not a url at all',
      '',
    ]) {
      expect(() => parsePrUrl(url), url).toThrow(InvalidPrUrlError);
    }
  });

  it('does not anchor the host — documented, and harmless because the fetch is read-only', () => {
    // The regex looks for `github.com/<owner>/<repo>/pull/<n>` anywhere in the
    // string, so a URL on another host still parses. It matters less than it
    // looks: only owner/repo/number survive, and they are handed to Octokit,
    // which always talks to github.com. Recorded so the looseness is a decision
    // rather than an accident.
    expect(parsePrUrl('https://example.com/proxy/github.com/o/r/pull/5')).toMatchObject({
      owner: 'o',
      repo: 'r',
      number: 5,
    });
  });
});

function ctx(files: PrContext['files']): PrContext {
  return {
    owner: 'o',
    repo: 'r',
    number: 1,
    headSha: 'deadbee',
    title: 'Title',
    body: null,
    author: 'someone',
    files,
  };
}

describe('renderDiff', () => {
  it('renders one header block per changed file', () => {
    const out = renderDiff(
      ctx([
        { filename: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1 +1 @@\n+a' },
        { filename: 'b.ts', status: 'added', additions: 9, deletions: 0, patch: '@@ -0,0 +1 @@\n+b' },
      ]),
    );
    expect(out).toContain('--- a.ts (modified, +2/-1) ---');
    expect(out).toContain('--- b.ts (added, +9/-0) ---');
    expect(out).toContain('PR #1: Title');
  });

  it('says so when a file has no textual patch', () => {
    const out = renderDiff(ctx([{ filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }]));
    expect(out).toContain('(no textual patch — binary or too large)');
  });

  it('says how much of a long patch it cut', () => {
    // A specialist reviewing a silently-sliced patch reports on a fraction of
    // the file with full confidence, and nothing downstream records that it
    // happened. The marker is the cheapest fix: the model can hedge and a
    // reader of the trace can see it.
    const huge = '+x'.repeat(5000); // 10k chars, over the 6000 cap
    const out = renderDiff(ctx([{ filename: 'big.ts', status: 'modified', additions: 5000, deletions: 0, patch: huge }]));
    expect(out).toContain('[patch truncated:');
    expect(out).toContain('of 10000 characters not shown]');
  });

  it('leaves a patch under the cap untouched and unmarked', () => {
    const small = '@@ -1 +1 @@\n+ok';
    const out = renderDiff(ctx([{ filename: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: small }]));
    expect(out).toContain(small);
    expect(out).not.toContain('truncated');
  });

  it('stops at the whole-diff budget instead of sending everything', () => {
    // The per-file cap bounded nothing on its own: paginate walked every page,
    // so a 300-file PR built ~1.8M characters and handed the same string to
    // four models at once.
    const many = Array.from({ length: 40 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      status: 'modified',
      additions: 100,
      deletions: 0,
      patch: 'x'.repeat(5000),
    }));
    const out = renderDiff(ctx(many), MAX_PATCH_CHARS, 20_000);
    expect(out.length).toBeLessThan(30_000);
    expect(out).toContain('changed file(s) omitted');
  });

  it('announces a file list that was cut short by the page cap', () => {
    const out = renderDiff({ ...ctx([]), truncatedFileList: true });
    expect(out).toContain('more changed files than were fetched');
  });

  it('caps the PR description and says so', () => {
    const long = 'd'.repeat(3000);
    const out = renderDiff({ ...ctx([]), body: long });
    expect(out).toContain('d'.repeat(1000));
    expect(out).not.toContain('d'.repeat(1001));
    expect(out).toContain('[description truncated]');
  });
});
