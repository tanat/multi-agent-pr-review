/**
 * Guards for the mutating routes.
 *
 * The deployment is public and unauthenticated, which is right for a demo you
 * want a reader to click. What is not right is that `POST /api/review` spends
 * model credits on any PR URL anyone posts, with no ceiling — the cost of an
 * open endpoint here is measured in tokens, not in data.
 *
 * So the two risks are separated rather than solved with one blanket auth
 * check that would take the demo offline:
 *
 *   - spending is rate-limited, which bounds the damage without asking a
 *     reader for a credential;
 *   - the one action that reaches outside this system — posting a comment on
 *     someone else's pull request — requires a shared secret whenever it is
 *     enabled at all.
 */

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

/** Requests per minute per client for the endpoints that call a model. */
export const REVIEW_RATE_LIMIT = 5;

export function clientKey(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';
}

/** True when this client is within its budget; records the hit when it is. */
export function withinRateLimit(key: string, limit = REVIEW_RATE_LIMIT, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

/** Test seam — the limiter is process-local, so state leaks between tests otherwise. */
export function resetRateLimit(): void {
  hits.clear();
}

/**
 * Whether this request may publish.
 *
 * Output-only publishing renders Markdown into the page and touches nothing
 * outside the process, so it stays open. Publishing for real writes to a third
 * party's pull request under the deployer's token; that path requires
 * PUBLISH_SECRET to be configured and presented, and refuses to run if the
 * feature is switched on without a secret rather than defaulting to open.
 */
export type PublishAuth = { ok: true } | { ok: false; status: 401 | 500; error: string };

export function checkPublishAuth(req: Request): PublishAuth {
  if (process.env.PUBLISH_MODE !== 'github') return { ok: true };

  const expected = process.env.PUBLISH_SECRET;
  if (!expected) {
    return {
      ok: false,
      status: 500,
      error: 'PUBLISH_MODE=github requires PUBLISH_SECRET to be set',
    };
  }
  const presented = req.headers.get('x-publish-secret');
  if (presented !== expected) {
    return { ok: false, status: 401, error: 'x-publish-secret does not match' };
  }
  return { ok: true };
}
