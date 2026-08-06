import { describe, expect, it } from 'vitest';
import { parseFixtureFiles, toPrContext } from '../to-pr-context';
import { FIXTURES } from '../fixtures';
import { renderDiff } from '@/lib/github';

describe('parseFixtureFiles', () => {
  it('splits a multi-file fixture and strips the a/ prefix', () => {
    const files = parseFixtureFiles(`--- a/src/one.ts (modified, +2/-1) ---
@@ -1 +1 @@
+one
--- a/src/two.ts (added, +3/-0) ---
@@ -0,0 +1 @@
+two`);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ filename: 'src/one.ts', status: 'modified', additions: 2, deletions: 1 });
    expect(files[1]).toMatchObject({ filename: 'src/two.ts', status: 'added', additions: 3, deletions: 0 });
    expect(files[0].patch).toContain('+one');
    expect(files[0].patch).not.toContain('+two');
  });
});

describe('every fixture survives the round trip', () => {
  it('parses into at least one file', () => {
    for (const fx of FIXTURES) {
      expect(parseFixtureFiles(fx.diff).length, fx.name).toBeGreaterThan(0);
    }
  });

  it('renders every gold file path exactly as the matcher expects it', () => {
    // The bug this guards: gold says `src/routes/users.ts`, the fixture text
    // said `a/src/routes/users.ts`, and production says `src/routes/users.ts`.
    // A path the model never sees cannot be a path the model reports.
    for (const [i, fx] of FIXTURES.entries()) {
      const rendered = renderDiff(toPrContext(fx, i));
      for (const g of fx.gold) {
        expect(rendered, `${fx.name} → ${g.file}`).toContain(`--- ${g.file} (`);
      }
    }
  });

  it('keeps the planted code in the rendered output', () => {
    const users = FIXTURES.find((f) => f.name === 'user-lookup-endpoint')!;
    const rendered = renderDiff(toPrContext(users, 0));
    expect(rendered).toContain("'SELECT * FROM users WHERE id = ' + id");
    expect(rendered).toContain('hardcoded-secret-EXAMPLE');
  });
});
