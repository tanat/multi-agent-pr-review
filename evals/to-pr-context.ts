import type { PrContext, PrFile } from '@/lib/github';
import type { Fixture } from './fixtures';

/**
 * Turn a fixture into the same shape `fetchPr` produces, so the eval can send
 * the diff through `renderDiff` exactly as production does.
 *
 * The harness used to pass `fixture.diff` straight to the model. That string
 * was written by hand in roughly the shape `renderDiff` emits — but only
 * roughly: fixtures write `--- a/src/routes/users.ts ---` while production
 * writes `--- src/routes/users.ts ---`, and gold entries record the path
 * without the prefix. The mismatch sat in the exact field the matcher keys on,
 * so the eval was scoring the model on a format it never sees in the app, and
 * any change to `renderDiff` — truncation markers, size budgets, header
 * wording — was invisible to the measurement.
 */
const HEADER = /^--- (?:a\/)?(.+?) \((\w+), \+(\d+)\/-(\d+)\) ---$/;

export function parseFixtureFiles(diff: string): PrFile[] {
  const files: PrFile[] = [];
  let current: PrFile | null = null;
  let patch: string[] = [];

  const flush = () => {
    if (current) files.push({ ...current, patch: patch.join('\n').trim() });
    patch = [];
  };

  for (const line of diff.split('\n')) {
    const m = HEADER.exec(line.trim());
    if (m) {
      flush();
      current = {
        filename: m[1],
        status: m[2],
        additions: Number(m[3]),
        deletions: Number(m[4]),
      };
      continue;
    }
    if (current) patch.push(line);
  }
  flush();
  return files;
}

export function toPrContext(fixture: Fixture, index: number): PrContext {
  return {
    owner: 'evals',
    repo: 'fixtures',
    number: index + 1,
    title: fixture.name,
    // Deliberately null. A hand-written PR description would be another place
    // to accidentally name the defect, which is the contamination this corpus
    // is trying to remove, not add.
    body: null,
    author: 'fixture',
    files: parseFixtureFiles(fixture.diff),
  };
}
