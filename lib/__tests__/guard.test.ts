import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REVIEW_RATE_LIMIT, checkPublishAuth, clientKey, resetRateLimit, withinRateLimit } from '../guard';

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://example.test/api', { method: 'POST', headers });
}

beforeEach(() => resetRateLimit());
afterEach(() => {
  delete process.env.PUBLISH_MODE;
  delete process.env.PUBLISH_SECRET;
});

describe('clientKey', () => {
  it('takes the first hop of x-forwarded-for', () => {
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientKey(req({ 'x-real-ip': '198.51.100.4' }))).toBe('198.51.100.4');
    expect(clientKey(req())).toBe('unknown');
  });
});

describe('withinRateLimit', () => {
  it('allows a client up to the limit and then stops it', () => {
    for (let i = 0; i < REVIEW_RATE_LIMIT; i++) {
      expect(withinRateLimit('a'), `call ${i + 1}`).toBe(true);
    }
    expect(withinRateLimit('a')).toBe(false);
  });

  it('budgets each client separately', () => {
    for (let i = 0; i < REVIEW_RATE_LIMIT; i++) withinRateLimit('a');
    expect(withinRateLimit('a')).toBe(false);
    expect(withinRateLimit('b')).toBe(true);
  });

  it('forgets hits once the window has passed', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < REVIEW_RATE_LIMIT; i++) withinRateLimit('a', REVIEW_RATE_LIMIT, t0);
    expect(withinRateLimit('a', REVIEW_RATE_LIMIT, t0)).toBe(false);
    expect(withinRateLimit('a', REVIEW_RATE_LIMIT, t0 + 60_001)).toBe(true);
  });

  it('does not let a blocked client extend its own block', () => {
    // A rejected request must not count as a hit, or a client hammering the
    // endpoint would never fall out of the window and the limit would become a
    // permanent ban instead of a ceiling.
    const t0 = 2_000_000;
    for (let i = 0; i < REVIEW_RATE_LIMIT; i++) withinRateLimit('a', REVIEW_RATE_LIMIT, t0);
    for (let i = 0; i < 50; i++) withinRateLimit('a', REVIEW_RATE_LIMIT, t0 + 30_000);
    expect(withinRateLimit('a', REVIEW_RATE_LIMIT, t0 + 60_001)).toBe(true);
  });
});

describe('checkPublishAuth', () => {
  it('leaves output-only publishing open', () => {
    expect(checkPublishAuth(req())).toEqual({ ok: true });
  });

  it('refuses to post for real when the feature is on but no secret is configured', () => {
    // Failing closed matters more here than anywhere else in the app: getting
    // this wrong means an open endpoint that writes to strangers' pull requests.
    process.env.PUBLISH_MODE = 'github';
    expect(checkPublishAuth(req())).toMatchObject({ ok: false, status: 500 });
  });

  it('requires the secret to match', () => {
    process.env.PUBLISH_MODE = 'github';
    process.env.PUBLISH_SECRET = 's3cret';
    expect(checkPublishAuth(req())).toMatchObject({ ok: false, status: 401 });
    expect(checkPublishAuth(req({ 'x-publish-secret': 'wrong' }))).toMatchObject({ ok: false, status: 401 });
    expect(checkPublishAuth(req({ 'x-publish-secret': 's3cret' }))).toEqual({ ok: true });
  });
});
