import type { Severity, Specialist } from '@/lib/schemas';

/**
 * Adversarial fixtures: small, realistic PR diffs with deliberately planted
 * issues. The `gold` array is the ground truth — what a perfect reviewer should
 * flag. The eval harness runs the real specialists against `diff` and scores
 * their findings against `gold` (precision/recall per specialist).
 *
 * Caveat (same as any planted-bug eval): the models sometimes flag *real* issues
 * we didn't plant. Those count against precision here even though they may be
 * legitimate — so treat precision as a lower bound. See evals/README.md.
 */
export interface GoldIssue {
  specialist: Specialist;
  file: string;
  /** Approx line in the new file; matched within ±LINE_TOLERANCE. null = file-level. */
  line: number | null;
  severity: Severity;
  note: string;
}

export interface Fixture {
  name: string;
  diff: string;
  gold: GoldIssue[];
}

export const FIXTURES: Fixture[] = [
  {
    name: 'user-lookup-endpoint',
    diff: `--- a/src/routes/users.ts (modified, +14/-2) ---
@@ -10,6 +10,18 @@ import { db } from '../db';
+const API_KEY = 'hardcoded-secret-EXAMPLE-do-not-commit';
+
+export async function getUser(req, res) {
+  const id = req.query.id;
+  // look up the user by id
+  const rows = await db.query(
+    'SELECT * FROM users WHERE id = ' + id
+  );
+  if (rows.length = 0) {
+    return res.status(404).send('not found');
+  }
+  res.json(rows[0]);
+}
`,
    gold: [
      { specialist: 'security', file: 'src/routes/users.ts', line: 16, severity: 'critical', note: 'SQL injection via string concatenation of req.query.id' },
      { specialist: 'security', file: 'src/routes/users.ts', line: 11, severity: 'critical', note: 'Hardcoded live API key committed' },
      { specialist: 'correctness', file: 'src/routes/users.ts', line: 19, severity: 'high', note: 'Assignment `rows.length = 0` instead of comparison `===`' },
    ],
  },
  {
    name: 'discount-calc',
    diff: `--- a/src/cart/discount.ts (modified, +12/-1) ---
@@ -3,7 +3,18 @@ export interface Item { price: number; qty: number }
+export function applyBulkDiscount(items: Item[]): number {
+  let total = 0;
+  // sum every item except the last one (off-by-one bug)
+  for (let i = 0; i <= items.length; i++) {
+    total += items[i].price * items[i].qty;
+  }
+  if (total > 100) {
+    total = total * 0.9;
+  }
+  return total;
+}
`,
    gold: [
      { specialist: 'correctness', file: 'src/cart/discount.ts', line: 7, severity: 'high', note: 'Loop bound `i <= items.length` reads items[length] -> undefined access' },
      { specialist: 'tests', file: 'src/cart/discount.ts', line: 5, severity: 'medium', note: 'New applyBulkDiscount has no test (boundary at total===100 untested)' },
    ],
  },
  {
    name: 'retry-helper',
    diff: `--- a/src/util/retry.ts (added, +16/-0) ---
@@ -0,0 +1,16 @@
+export async function r(fn, n) {
+  let e;
+  for (let i = 0; i < n; i++) {
+    try {
+      return await fn();
+    } catch (err) {
+      e = err;
+    }
+  }
+  throw e;
+}
+
+export function r2(fn) {
+  return r(fn, 3);
+}
`,
    gold: [
      { specialist: 'style', file: 'src/util/retry.ts', line: 1, severity: 'medium', note: 'Non-descriptive names r/r2/n/e; no types on params' },
      { specialist: 'tests', file: 'src/util/retry.ts', line: 1, severity: 'medium', note: 'New retry helper has no tests (success-after-failures, exhaustion)' },
      { specialist: 'correctness', file: 'src/util/retry.ts', line: 1, severity: 'low', note: 'No backoff/delay between retries; tight loop hammers the callee' },
    ],
  },
];
