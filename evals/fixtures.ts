import type { Severity, Specialist } from '@/lib/schemas';

/**
 * Adversarial fixtures: small, realistic PR diffs with deliberately planted
 * defects. The harness runs the four real specialists against each diff and
 * scores their findings against the gold set.
 *
 * Three properties this corpus is built to have, each answering a way the
 * previous three-fixture set produced numbers that could not be read:
 *
 * 1. **Every lens has gold in most fixtures.** Before, two of three fixtures
 *    planted nothing for `style` and one planted nothing for `tests`, and the
 *    scorer partitions gold per specialist — so a correct observation in an
 *    empty cell counted as a false positive. Those precision numbers measured
 *    the gold set's holes, not the lens.
 *
 * 2. **Half the defects are classes the prompt does not name.** `lib/specialists.ts`
 *    lists "injection (SQL/command/path), secrets or credentials committed" and
 *    the old fixtures planted exactly those, so a keyword lookup would score
 *    well. Each gold entry carries `primed`, and the harness reports recall
 *    split by it: catching a defect the prompt named is a different claim from
 *    catching one it did not.
 *
 * 3. **Some diffs are clean.** A corpus where every fixture hides a bug cannot
 *    measure the cost of a lens that always finds something. Fixtures with
 *    `gold: []` are the only place a false positive is unambiguous.
 *
 * `signals` are the phrases that mark a finding as being about this defect; all
 * words of one phrase must appear. They describe the defect, never the fix, so
 * a finding is not credited for proposing the right change while misdiagnosing
 * the cause.
 */
export interface GoldIssue {
  specialist: Specialist;
  /** Stable id, reported in `missedConcepts` so a bad score names what was missed. */
  concept: string;
  file: string;
  /** Approx line in the new file; matched within ±LINE_TOLERANCE. null = file-level. */
  line: number | null;
  severity: Severity;
  /** Any one of these (all words present) identifies a finding as this defect. */
  signals: string[];
  /** Phrases that indicate a *different* defect, to keep near misses from counting. */
  antiSignals?: string[];
  /** True when the specialist's prompt names this defect class in so many words. */
  primed: boolean;
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
      {
        specialist: 'security',
        concept: 'sql_injection',
        file: 'src/routes/users.ts',
        line: 16,
        severity: 'critical',
        primed: true,
        signals: ['sql injection', 'injection', 'concatenation query', 'parameterised', 'parameterized'],
        note: 'SQL injection via string concatenation of req.query.id',
      },
      {
        specialist: 'security',
        concept: 'committed_secret',
        file: 'src/routes/users.ts',
        line: 11,
        severity: 'critical',
        primed: true,
        signals: ['hardcoded secret', 'hardcoded key', 'credential committed', 'secret committed', 'api key'],
        note: 'Hardcoded live API key committed',
      },
      {
        specialist: 'correctness',
        concept: 'assignment_in_condition',
        file: 'src/routes/users.ts',
        line: 19,
        severity: 'high',
        primed: true,
        signals: ['assignment instead comparison', 'assignment condition', 'single equals', 'always truthy'],
        note: 'Assignment `rows.length = 0` instead of comparison `===`',
      },
      {
        specialist: 'security',
        concept: 'row_leaks_all_columns',
        file: 'src/routes/users.ts',
        line: 21,
        severity: 'high',
        primed: false,
        signals: ['select star', 'all columns', 'password hash', 'sensitive fields', 'over fetching', 'overfetching'],
        note: 'SELECT * returns every column, including the password hash, straight to the client',
      },
      {
        specialist: 'tests',
        concept: 'new_endpoint_untested',
        file: 'src/routes/users.ts',
        line: null,
        severity: 'medium',
        primed: true,
        signals: ['test', 'coverage', 'untested'],
        note: 'A new HTTP handler lands with no test at all',
      },
      {
        specialist: 'style',
        concept: 'untyped_handler_params',
        file: 'src/routes/users.ts',
        line: 13,
        severity: 'low',
        primed: true,
        signals: ['missing types', 'untyped', 'implicit any', 'type annotation'],
        note: 'req/res have no types in a TypeScript file',
      },
    ],
  },

  {
    name: 'discount-calc',
    diff: `--- a/src/cart/discount.ts (modified, +12/-1) ---
@@ -3,7 +3,19 @@ export interface Item { price: number; qty: number }
+export function applyBulkDiscount(items: Item[]): number {
+  let total = 0;
+  for (let i = 0; i <= items.length; i++) {
+    total += items[i].price * items[i].qty;
+  }
+  if (total > 100) {
+    total = total * 0.9;
+  }
+  return total;
+}
+
+export const applyBulk = applyBulkDiscount;
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'off_by_one',
        file: 'src/cart/discount.ts',
        line: 6,
        severity: 'high',
        primed: true,
        signals: ['off one', 'out bounds', 'past end', 'undefined element', 'loop bound'],
        note: 'i <= items.length reads one past the end and throws on the last iteration',
      },
      {
        specialist: 'correctness',
        concept: 'float_money',
        file: 'src/cart/discount.ts',
        line: 10,
        severity: 'medium',
        primed: false,
        signals: ['floating point', 'rounding', 'cents', 'decimal precision', 'currency precision'],
        note: 'Money held in floats; total * 0.9 produces fractions of a cent that accumulate',
      },
      {
        specialist: 'tests',
        concept: 'boundary_untested',
        file: 'src/cart/discount.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['edge case', 'boundary', 'empty array', 'no test', 'coverage'],
        note: 'No test covers the empty-array or single-item boundary the loop gets wrong',
      },
      {
        specialist: 'style',
        concept: 'magic_number',
        file: 'src/cart/discount.ts',
        line: 9,
        severity: 'low',
        primed: false,
        signals: ['magic number', 'named constant', 'hardcoded threshold', 'unexplained literal'],
        note: 'The 100 threshold and the 0.9 rate are unexplained literals',
      },
      {
        specialist: 'style',
        concept: 'redundant_alias',
        file: 'src/cart/discount.ts',
        line: 14,
        severity: 'low',
        primed: true,
        signals: ['alias', 'duplicate export', 'dead code', 'redundant'],
        note: 'applyBulk is a second name for the same function with no caller',
      },
    ],
  },

  {
    name: 'session-token-compare',
    diff: `--- a/src/auth/session.ts (modified, +16/-3) ---
@@ -20,10 +20,26 @@ import { store } from './store';
+export function verifySessionToken(presented: string, sessionId: string): boolean {
+  const expected = store.tokenFor(sessionId);
+  if (!expected) return false;
+  return presented === expected;
+}
+
+export function newSessionId(): string {
+  return Math.random().toString(36).slice(2);
+}
+
+export async function loadSession(id: string) {
+  const raw = await store.read(id);
+  return JSON.parse(raw);
+}
`,
    gold: [
      {
        specialist: 'security',
        concept: 'timing_unsafe_compare',
        file: 'src/auth/session.ts',
        line: 24,
        severity: 'high',
        primed: false,
        signals: ['timing attack', 'constant time', 'timing safe', 'early exit comparison'],
        note: 'Secret compared with === , which short-circuits and leaks length/prefix by timing',
      },
      {
        specialist: 'security',
        concept: 'weak_randomness',
        file: 'src/auth/session.ts',
        line: 28,
        severity: 'critical',
        primed: true,
        signals: ['math random', 'insecure random', 'predictable', 'cryptographically secure', 'weak randomness'],
        note: 'Session ids from Math.random() are predictable',
      },
      {
        specialist: 'correctness',
        concept: 'unhandled_parse_throw',
        file: 'src/auth/session.ts',
        line: 33,
        severity: 'medium',
        primed: true,
        signals: ['json parse throw', 'error handling', 'try catch', 'malformed json', 'unhandled exception'],
        note: 'JSON.parse on stored data with no guard; corrupt data takes down the request',
      },
      {
        specialist: 'tests',
        concept: 'security_path_untested',
        file: 'src/auth/session.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['no test', 'coverage', 'untested', 'test missing'],
        note: 'Token verification — the security boundary — ships untested',
      },
      {
        specialist: 'style',
        concept: 'missing_return_type',
        file: 'src/auth/session.ts',
        line: 31,
        severity: 'low',
        primed: true,
        signals: ['return type', 'missing types', 'inferred any', 'untyped'],
        note: 'loadSession returns an implicit any from JSON.parse',
      },
    ],
  },

  {
    name: 'search-regex-filter',
    diff: `--- a/src/search/filter.ts (modified, +11/-0) ---
@@ -1,4 +1,15 @@
+export function matchesQuery(text: string, query: string): boolean {
+  const pattern = new RegExp('(\\\\w+\\\\s*)+' + query, 'i');
+  return pattern.test(text);
+}
+
+export function highlight(text: string, terms: string[]): string {
+  let out = text;
+  for (const t of terms) {
+    out = out.replace(new RegExp(t, 'g'), '<mark>' + t + '</mark>');
+  }
+  return out;
+}
`,
    gold: [
      {
        specialist: 'security',
        concept: 'redos',
        file: 'src/search/filter.ts',
        line: 2,
        severity: 'high',
        primed: false,
        signals: ['catastrophic backtracking', 'redos', 'denial service regex', 'exponential regex', 'nested quantifier'],
        note: 'Nested quantifier (\\w+\\s*)+ against user input is catastrophic backtracking',
      },
      {
        specialist: 'security',
        concept: 'regex_injection',
        file: 'src/search/filter.ts',
        line: 2,
        severity: 'medium',
        primed: true,
        signals: ['unescaped input regex', 'regex injection', 'escape user input', 'unvalidated input'],
        antiSignals: ['catastrophic backtracking', 'redos'],
        note: 'query is interpolated into a RegExp without escaping',
      },
      {
        specialist: 'security',
        concept: 'xss_via_highlight',
        file: 'src/search/filter.ts',
        line: 10,
        severity: 'high',
        primed: true,
        signals: ['xss', 'cross site scripting', 'html escaping', 'unescaped html', 'markup injection'],
        note: 'Terms are spliced into HTML without escaping',
      },
      {
        specialist: 'correctness',
        concept: 'replace_reenters_markup',
        file: 'src/search/filter.ts',
        line: 10,
        severity: 'medium',
        primed: true,
        signals: ['already highlighted', 'nested mark', 'previous replacement', 'overlapping terms', 'double wrap'],
        note: 'Each pass rewrites text the previous pass wrapped, so terms inside <mark> get wrapped again',
      },
      {
        specialist: 'style',
        concept: 'regex_rebuilt_in_loop',
        file: 'src/search/filter.ts',
        line: 10,
        severity: 'low',
        primed: false,
        signals: ['compiled loop', 'recreate regex', 'hoist', 'rebuilt every iteration'],
        note: 'A RegExp is constructed per term per call instead of once',
      },
    ],
  },

  {
    name: 'report-scheduler',
    diff: `--- a/src/reports/schedule.ts (modified, +14/-2) ---
@@ -8,8 +8,22 @@ import { sendReport } from './mailer';
+export function nextRunAt(lastRun: Date): Date {
+  const next = new Date(lastRun);
+  next.setHours(next.getHours() + 24);
+  return next;
+}
+
+export function isDue(schedule: { hour: number }, now = new Date()): boolean {
+  return now.getHours() === schedule.hour;
+}
+
+export async function runDaily(userIds: string[]) {
+  for (const id of userIds) {
+    await sendReport(id);
+  }
+}
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'dst_arithmetic',
        file: 'src/reports/schedule.ts',
        line: 11,
        severity: 'high',
        primed: false,
        signals: ['daylight saving', 'dst', 'timezone', 'utc', 'clock change'],
        note: 'Adding 24 hours is not "the next day" across a DST boundary',
      },
      {
        specialist: 'correctness',
        concept: 'local_timezone_dependence',
        file: 'src/reports/schedule.ts',
        line: 16,
        severity: 'medium',
        primed: false,
        signals: ['server timezone', 'local time', 'getHours locale', 'timezone dependent'],
        antiSignals: ['daylight saving', 'dst'],
        note: 'isDue compares against the server’s local hour, so behaviour depends on deploy region',
      },
      {
        specialist: 'correctness',
        concept: 'one_failure_stops_batch',
        file: 'src/reports/schedule.ts',
        line: 21,
        severity: 'high',
        primed: true,
        signals: ['one failure', 'rejects whole', 'error handling loop', 'remaining users', 'partial failure'],
        note: 'A single send that rejects aborts the loop and the rest never get their report',
      },
      {
        specialist: 'tests',
        concept: 'time_untestable',
        file: 'src/reports/schedule.ts',
        line: null,
        severity: 'medium',
        primed: true,
        signals: ['no test', 'coverage', 'fake timers', 'untested', 'deterministic clock'],
        note: 'Date-dependent logic with a default `new Date()` and no test or injectable clock',
      },
      {
        specialist: 'style',
        concept: 'sequential_await_loop',
        file: 'src/reports/schedule.ts',
        line: 21,
        severity: 'low',
        primed: false,
        signals: ['sequential await', 'await loop', 'serial', 'concurrency', 'promise all'],
        note: 'Reports are sent one at a time when they are independent',
      },
    ],
  },

  {
    name: 'cache-layer',
    diff: `--- a/src/cache/store.ts (modified, +15/-1) ---
@@ -1,6 +1,21 @@
+const cache = new Map<string, unknown>();
+
+export function remember<T>(key: string, value: T): T {
+  cache.set(key, value);
+  return value;
+}
+
+export function cached<T>(key: string): T | undefined {
+  return cache.get(key) as T | undefined;
+}
+
+export async function getUserProfile(id: string) {
+  const hit = cached<Profile>('profile');
+  if (hit) return hit;
+  return remember('profile', await fetchProfile(id));
+}
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'cache_key_ignores_id',
        file: 'src/cache/store.ts',
        line: 14,
        severity: 'critical',
        primed: true,
        signals: ['same key', 'key includes', 'user id key', 'wrong user', 'cross user', 'shared cache entry'],
        note: 'The cache key is the constant "profile", so the first user’s data is served to everyone',
      },
      {
        specialist: 'correctness',
        concept: 'no_eviction',
        file: 'src/cache/store.ts',
        line: 2,
        severity: 'high',
        primed: false,
        signals: ['unbounded growth', 'never evicted', 'memory leak', 'no ttl', 'grows forever'],
        note: 'An unbounded module-level Map that is never evicted',
      },
      {
        specialist: 'security',
        concept: 'cross_tenant_leak',
        file: 'src/cache/store.ts',
        line: 14,
        severity: 'critical',
        primed: true,
        signals: ['data leak users', 'authorization', 'tenant isolation', 'other user data', 'access control'],
        note: 'The shared key is an authorisation failure, not just a caching bug',
      },
      {
        specialist: 'tests',
        concept: 'cache_isolation_untested',
        file: 'src/cache/store.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['no test', 'two users', 'isolation test', 'coverage', 'untested'],
        note: 'No test asks whether two different ids get two different profiles',
      },
      {
        specialist: 'style',
        concept: 'unsafe_cast',
        file: 'src/cache/store.ts',
        line: 10,
        severity: 'medium',
        primed: true,
        signals: ['unchecked cast', 'type assertion', 'lies about type', 'unsafe as'],
        note: '`as T` asserts a type the Map cannot guarantee',
      },
    ],
  },

  {
    name: 'file-upload-handler',
    diff: `--- a/src/upload/handler.ts (modified, +17/-2) ---
@@ -12,8 +12,25 @@ import path from 'node:path';
+export async function saveUpload(req: Request) {
+  const form = await req.formData();
+  const file = form.get('file') as File;
+  const dest = path.join(UPLOAD_DIR, file.name);
+  const stream = fs.createWriteStream(dest);
+  stream.write(Buffer.from(await file.arrayBuffer()));
+  return { path: dest, size: file.size };
+}
+
+export function isAllowed(name: string): boolean {
+  return name.endsWith('.png') || name.endsWith('.jpg');
+}
`,
    gold: [
      {
        specialist: 'security',
        concept: 'path_traversal',
        file: 'src/upload/handler.ts',
        line: 16,
        severity: 'critical',
        primed: true,
        signals: ['path traversal', 'directory traversal', 'dot dot slash', 'sanitise filename', 'sanitize filename', 'arbitrary write'],
        note: 'file.name goes straight into path.join, so ../../ escapes the upload directory',
      },
      {
        specialist: 'security',
        concept: 'extension_check_unused',
        file: 'src/upload/handler.ts',
        line: 22,
        severity: 'high',
        primed: true,
        signals: ['never called', 'not enforced', 'unused validation', 'bypass check', 'validation missing'],
        note: 'isAllowed exists but saveUpload never calls it',
      },
      {
        specialist: 'correctness',
        concept: 'stream_never_closed',
        file: 'src/upload/handler.ts',
        line: 18,
        severity: 'high',
        primed: false,
        signals: ['not closed', 'file descriptor', 'resource leak', 'end stream', 'never ends'],
        note: 'The write stream is never ended or closed; descriptors leak and writes may not flush',
      },
      {
        specialist: 'correctness',
        concept: 'returns_before_write_completes',
        file: 'src/upload/handler.ts',
        line: 19,
        severity: 'high',
        primed: true,
        signals: ['before write completes', 'not awaited', 'race', 'returns early', 'asynchronous write'],
        antiSignals: ['file descriptor', 'resource leak'],
        note: 'The function returns while the write is still in flight',
      },
      {
        specialist: 'style',
        concept: 'unchecked_form_cast',
        file: 'src/upload/handler.ts',
        line: 15,
        severity: 'medium',
        primed: true,
        signals: ['as file cast', 'unchecked cast', 'type assertion', 'could null'],
        note: '`form.get(...) as File` hides that the field may be absent',
      },
      {
        specialist: 'tests',
        concept: 'upload_untested',
        file: 'src/upload/handler.ts',
        line: null,
        severity: 'medium',
        primed: true,
        signals: ['no test', 'coverage', 'untested', 'test missing'],
        note: 'No test for a handler that writes to the filesystem from user input',
      },
    ],
  },

  {
    name: 'pagination-fetch',
    diff: `--- a/src/api/list.ts (modified, +13/-4) ---
@@ -5,10 +5,23 @@ import { client } from './client';
+export async function listAll(org: string) {
+  const out = [];
+  let page = 1;
+  while (true) {
+    const res = await client.get(\`/orgs/\${org}/items?page=\${page}\`);
+    out.push(...res.data);
+    if (res.data.length === 0) break;
+    page++;
+  }
+  return out;
+}
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'unbounded_pagination',
        file: 'src/api/list.ts',
        line: 9,
        severity: 'high',
        primed: false,
        signals: ['unbounded', 'no limit pages', 'infinite loop', 'memory exhaustion', 'page cap', 'rate limit'],
        note: 'No page cap and no total budget; a large org loads everything into memory',
      },
      {
        specialist: 'correctness',
        concept: 'no_error_handling',
        file: 'src/api/list.ts',
        line: 10,
        severity: 'medium',
        primed: true,
        signals: ['error handling', 'network failure', 'retry', 'rejects', 'try catch'],
        note: 'A single transient failure discards every page already fetched',
      },
      {
        specialist: 'style',
        concept: 'untyped_accumulator',
        file: 'src/api/list.ts',
        line: 7,
        severity: 'low',
        primed: true,
        signals: ['any array', 'untyped', 'missing types', 'implicit any'],
        note: 'const out = [] infers any[]',
      },
      {
        specialist: 'tests',
        concept: 'pagination_untested',
        file: 'src/api/list.ts',
        line: null,
        severity: 'medium',
        primed: true,
        signals: ['no test', 'coverage', 'multiple pages', 'untested'],
        note: 'Nothing exercises the multi-page path or the termination condition',
      },
    ],
  },

  {
    name: 'order-total-refactor',
    diff: `--- a/src/orders/total.ts (modified, +9/-11) ---
@@ -14,17 +14,15 @@ export interface Order { lines: Line[]; shipping: number; taxRate: number }
-export function total(order: Order): number {
-  const sub = order.lines.reduce((a, l) => a + l.price * l.qty, 0);
-  const tax = sub * order.taxRate;
-  return sub + tax + order.shipping;
-}
+export function total(order: Order): number {
+  const sub = order.lines.reduce((a, l) => a + l.price * l.qty, 0);
+  const tax = (sub + order.shipping) * order.taxRate;
+  return sub + tax + order.shipping;
+}
--- a/src/orders/total.test.ts (modified, +2/-2) ---
@@ -3,8 +3,8 @@ import { total } from './total';
 it('totals an order', () => {
-  expect(total(order)).toBe(115.5);
+  expect(total(order)).toBeGreaterThan(0);
 });
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'tax_base_changed',
        file: 'src/orders/total.ts',
        line: 20,
        severity: 'critical',
        primed: true,
        signals: ['shipping taxed', 'tax base', 'behaviour change', 'behavior change', 'different result', 'regression'],
        note: 'Shipping is now inside the tax base — a silent pricing change',
      },
      {
        specialist: 'tests',
        concept: 'assertion_weakened',
        file: 'src/orders/total.test.ts',
        line: 6,
        severity: 'critical',
        primed: true,
        signals: ['weakened assertion', 'greater than zero', 'no longer exercises', 'passes any', 'exact value removed'],
        note: 'The exact-value assertion was replaced with one that passes for almost any output — the test was changed to fit the bug',
      },
      {
        specialist: 'tests',
        concept: 'no_test_for_new_behaviour',
        file: 'src/orders/total.test.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['no test new', 'coverage', 'untested change', 'missing case'],
        antiSignals: ['weakened assertion', 'greater than zero'],
        note: 'Nothing asserts the new tax base is intended',
      },
    ],
  },

  {
    name: 'notification-dedupe',
    diff: `--- a/src/notify/dedupe.ts (modified, +14/-0) ---
@@ -1,3 +1,17 @@
+const sent = new Set<string>();
+
+export async function notifyOnce(userId: string, message: string) {
+  const key = userId + message;
+  if (sent.has(key)) return false;
+  await deliver(userId, message);
+  sent.add(key);
+  return true;
+}
+
+export function resetForTest() {
+  sent.clear();
+}
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'check_then_act_race',
        file: 'src/notify/dedupe.ts',
        line: 6,
        severity: 'high',
        primed: true,
        signals: ['race condition', 'check then act', 'concurrent calls', 'await between', 'not atomic', 'duplicate delivery'],
        note: 'The key is added after the await, so two concurrent calls both deliver',
      },
      {
        specialist: 'correctness',
        concept: 'ambiguous_key_concat',
        file: 'src/notify/dedupe.ts',
        line: 5,
        severity: 'medium',
        primed: false,
        signals: ['key collision', 'concatenation ambiguous', 'separator', 'delimiter'],
        note: 'userId + message collides: ("ab","c") and ("a","bc") produce the same key',
      },
      {
        specialist: 'correctness',
        concept: 'state_lost_on_restart',
        file: 'src/notify/dedupe.ts',
        line: 2,
        severity: 'medium',
        primed: false,
        signals: ['in memory', 'not persisted', 'process restart', 'multiple instances', 'per instance'],
        note: 'Dedup state is per-process, so a restart or a second instance re-notifies',
      },
      {
        specialist: 'style',
        concept: 'test_hook_in_production',
        file: 'src/notify/dedupe.ts',
        line: 13,
        severity: 'low',
        primed: true,
        signals: ['test only export', 'production code test', 'leaky abstraction', 'resetfortest'],
        note: 'A test-only reset is exported from production code',
      },
      {
        specialist: 'tests',
        concept: 'concurrency_untested',
        file: 'src/notify/dedupe.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['no test', 'concurrent test', 'coverage', 'untested', 'race untested'],
        note: 'Nothing tests two overlapping calls, which is the case that breaks',
      },
    ],
  },

  {
    name: 'flaky-retry-test',
    diff: `--- a/src/http/retry.test.ts (modified, +12/-0) ---
@@ -1,4 +1,16 @@
+it('retries until it succeeds', async () => {
+  let calls = 0;
+  const fn = async () => {
+    calls++;
+    if (calls < 3) throw new Error('boom');
+    return 'ok';
+  };
+  const p = withRetry(fn);
+  await new Promise((r) => setTimeout(r, 250));
+  expect(await p).toBe('ok');
+});
`,
    gold: [
      {
        specialist: 'tests',
        concept: 'sleep_based_flake',
        file: 'src/http/retry.test.ts',
        line: 10,
        severity: 'high',
        primed: true,
        signals: ['flaky', 'settimeout test', 'real timers', 'timing dependent', 'sleep', 'fake timers'],
        note: 'A fixed 250 ms sleep makes the test timing-dependent on CI',
      },
      {
        specialist: 'tests',
        concept: 'no_backoff_assertion',
        file: 'src/http/retry.test.ts',
        line: 11,
        severity: 'medium',
        primed: true,
        signals: ['does not assert', 'attempt count', 'backoff untested', 'weak assertion', 'only checks result'],
        antiSignals: ['flaky', 'settimeout test'],
        note: 'Nothing asserts how many attempts happened or that backoff was applied',
      },
      {
        specialist: 'style',
        concept: 'unclear_test_name',
        file: 'src/http/retry.test.ts',
        line: 2,
        severity: 'low',
        primed: true,
        signals: ['test name', 'naming', 'unclear describes'],
        note: 'The name does not say what "until it succeeds" bounds',
      },
    ],
  },

  {
    name: 'config-merge',
    diff: `--- a/src/config/merge.ts (modified, +13/-0) ---
@@ -1,3 +1,16 @@
+export function deepMerge(base: any, override: any): any {
+  for (const key of Object.keys(override)) {
+    if (typeof override[key] === 'object' && override[key] !== null) {
+      base[key] = deepMerge(base[key] || {}, override[key]);
+    } else {
+      base[key] = override[key];
+    }
+  }
+  return base;
+}
+
+export const loadUserConfig = (raw: string) => deepMerge(defaults, JSON.parse(raw));
`,
    gold: [
      {
        specialist: 'security',
        concept: 'prototype_pollution',
        file: 'src/config/merge.ts',
        line: 3,
        severity: 'critical',
        primed: false,
        signals: ['prototype pollution', 'proto', 'constructor prototype', 'object prototype'],
        note: '__proto__ in user JSON walks straight into Object.prototype',
      },
      {
        specialist: 'correctness',
        concept: 'mutates_defaults',
        file: 'src/config/merge.ts',
        line: 7,
        severity: 'high',
        primed: true,
        signals: ['mutates argument', 'in place', 'shared defaults', 'side effect', 'not pure'],
        note: 'deepMerge mutates `base`, so `defaults` is permanently changed by the first load',
      },
      {
        specialist: 'correctness',
        concept: 'array_merged_as_object',
        file: 'src/config/merge.ts',
        line: 4,
        severity: 'medium',
        primed: false,
        signals: ['array treated object', 'arrays merged', 'typeof array', 'index keys'],
        note: 'typeof [] === "object", so arrays merge index-wise instead of replacing',
      },
      {
        specialist: 'style',
        concept: 'any_signature',
        file: 'src/config/merge.ts',
        line: 2,
        severity: 'medium',
        primed: true,
        signals: ['any type', 'missing types', 'generic instead any', 'untyped signature'],
        note: 'any in, any out, on the function that shapes all configuration',
      },
      {
        specialist: 'tests',
        concept: 'merge_untested',
        file: 'src/config/merge.ts',
        line: null,
        severity: 'high',
        primed: true,
        signals: ['no test', 'coverage', 'untested', 'nested case'],
        note: 'Recursive merge with no test for nesting, arrays, or hostile keys',
      },
    ],
  },

  {
    name: 'admin-role-check',
    diff: `--- a/src/admin/guard.ts (modified, +10/-3) ---
@@ -4,9 +4,16 @@ import { getUser } from '../auth';
+export async function requireAdmin(req: Request) {
+  const user = await getUser(req);
+  if (user.role !== 'admin') {
+    console.warn('non-admin access attempt', user.id);
+  }
+  return user;
+}
+
+export const isAdmin = (u: { role?: string }) => u.role == 'admin';
`,
    gold: [
      {
        specialist: 'security',
        concept: 'authz_logged_not_enforced',
        file: 'src/admin/guard.ts',
        line: 7,
        severity: 'critical',
        primed: true,
        signals: ['does not block', 'only logs', 'not enforced', 'authorization bypass', 'authorisation bypass', 'still returns', 'missing authz'],
        note: 'The role check logs and then returns the user anyway — it enforces nothing',
      },
      {
        specialist: 'security',
        concept: 'pii_in_logs',
        file: 'src/admin/guard.ts',
        line: 8,
        severity: 'low',
        primed: false,
        signals: ['logs user id', 'pii log', 'sensitive log', 'identifier logged'],
        note: 'User identifiers written to logs on every failed attempt',
      },
      {
        specialist: 'correctness',
        concept: 'loose_equality',
        file: 'src/admin/guard.ts',
        line: 12,
        severity: 'medium',
        primed: true,
        signals: ['loose equality', 'double equals', 'strict equality', 'type coercion'],
        note: '== instead of === on a possibly-undefined field',
      },
      {
        specialist: 'tests',
        concept: 'authz_untested',
        file: 'src/admin/guard.ts',
        line: null,
        severity: 'critical',
        primed: true,
        signals: ['no test', 'coverage', 'untested', 'non admin test'],
        note: 'No test asserts that a non-admin is refused',
      },
      {
        specialist: 'style',
        concept: 'two_ways_same_check',
        file: 'src/admin/guard.ts',
        line: 12,
        severity: 'low',
        primed: true,
        signals: ['duplication', 'two implementations', 'same check twice', 'diverge'],
        note: 'requireAdmin and isAdmin implement the same rule differently',
      },
    ],
  },

  {
    name: 'csv-export',
    diff: `--- a/src/export/csv.ts (modified, +12/-1) ---
@@ -2,7 +2,19 @@
+export function toCsv(rows: Record<string, string>[]): string {
+  const headers = Object.keys(rows[0]);
+  const lines = [headers.join(',')];
+  for (const row of rows) {
+    lines.push(headers.map((h) => row[h]).join(','));
+  }
+  return lines.join('\\n');
+}
`,
    gold: [
      {
        specialist: 'correctness',
        concept: 'no_csv_escaping',
        file: 'src/export/csv.ts',
        line: 7,
        severity: 'high',
        primed: true,
        signals: ['comma value', 'quoting', 'escaping csv', 'quotes', 'newline field', 'breaks format'],
        note: 'Values containing a comma, quote or newline corrupt the file',
      },
      {
        specialist: 'correctness',
        concept: 'empty_rows_throws',
        file: 'src/export/csv.ts',
        line: 3,
        severity: 'medium',
        primed: true,
        signals: ['empty array', 'rows undefined', 'index zero', 'throws empty', 'null undefined'],
        note: 'rows[0] on an empty array throws',
      },
      {
        specialist: 'security',
        concept: 'csv_formula_injection',
        file: 'src/export/csv.ts',
        line: 7,
        severity: 'medium',
        primed: false,
        signals: ['formula injection', 'csv injection', 'equals sign spreadsheet', 'excel formula'],
        note: 'A value starting with = executes as a formula when opened in a spreadsheet',
      },
      {
        specialist: 'tests',
        concept: 'csv_untested',
        file: 'src/export/csv.ts',
        line: null,
        severity: 'medium',
        primed: true,
        signals: ['no test', 'coverage', 'untested', 'edge case'],
        note: 'No test for quoting, empty input, or ragged rows',
      },
      {
        specialist: 'style',
        concept: 'headers_from_first_row',
        file: 'src/export/csv.ts',
        line: 3,
        severity: 'low',
        primed: true,
        signals: ['first row headers', 'implicit contract', 'assumes uniform', 'leaky assumption'],
        note: 'Column set is silently defined by whichever row happens to be first',
      },
    ],
  },

  // ---- Clean diffs. The only place a false positive is unambiguous: there is
  // nothing planted, so anything a lens reports here is noise it generated on
  // its own. Without these, precision can only be measured against a gold set
  // that is known to be incomplete.

  {
    name: 'clean-readme-and-types',
    diff: `--- a/README.md (modified, +3/-1) ---
@@ -12,7 +12,9 @@ Run the server:
-    npm start
+    npm run start
+
+The default port is 3000; override it with PORT.
--- a/src/types/order.ts (modified, +2/-0) ---
@@ -5,6 +5,8 @@ export interface Order {
   lines: Line[];
+  /** ISO-8601 timestamp of when the order was placed. */
+  placedAt: string;
 }
`,
    gold: [],
  },

  {
    name: 'clean-guard-clause',
    diff: `--- a/src/cart/apply.ts (modified, +6/-4) ---
@@ -8,12 +8,14 @@ export function applyCoupon(cart: Cart, coupon: Coupon | null): Cart {
-  if (coupon) {
-    if (coupon.active) {
-      return { ...cart, discount: coupon.percent };
-    }
-  }
-  return cart;
+  if (!coupon) return cart;
+  if (!coupon.active) return cart;
+  return { ...cart, discount: coupon.percent };
 }
--- a/src/cart/apply.test.ts (modified, +6/-0) ---
@@ -10,3 +10,9 @@ it('applies an active coupon', () => {
+
+it('ignores an inactive coupon', () => {
+  expect(applyCoupon(cart, { active: false, percent: 10 })).toEqual(cart);
+});
+
+it('ignores a missing coupon', () => {
+  expect(applyCoupon(cart, null)).toEqual(cart);
+});
`,
    gold: [],
  },
];

/** Every planted defect across the corpus. */
export const ALL_GOLD: GoldIssue[] = FIXTURES.flatMap((f) => f.gold);
