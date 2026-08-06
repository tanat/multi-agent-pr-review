import { afterEach, describe, expect, it } from 'vitest';
import { recordingKey, vcrMode } from '../cache';

const base = {
  model: 'claude-sonnet-4-6',
  promptVersion: 'v1.0.0',
  fixture: 'user-lookup-endpoint',
  specialist: 'security' as const,
  diff: '--- a/src/routes/users.ts ---\n+const API_KEY = "x";',
};

afterEach(() => {
  delete process.env.EVAL_VCR;
});

describe('recordingKey', () => {
  it('is stable for identical input', () => {
    expect(recordingKey(base)).toBe(recordingKey({ ...base }));
  });

  it('separates every axis that changes what the model was asked', () => {
    const key = recordingKey(base);
    expect(recordingKey({ ...base, model: 'gpt-4o' })).not.toBe(key);
    expect(recordingKey({ ...base, promptVersion: 'v1.1.0' })).not.toBe(key);
    expect(recordingKey({ ...base, specialist: 'correctness' })).not.toBe(key);
    expect(recordingKey({ ...base, fixture: 'discount-calc' })).not.toBe(key);
  });

  it('changes when the fixture diff is edited', () => {
    // Without the diff in the key, editing a fixture would keep replaying the
    // answer the model gave to the *old* diff, and the eval would score a
    // generation that never saw the code it is being credited for.
    expect(recordingKey({ ...base, diff: base.diff + '\n+// one more line' })).not.toBe(recordingKey(base));
  });

  it('separates repeated samples of the same request', () => {
    // Repeated sampling only measures spread if each sample gets its own slot;
    // sharing one would return the same recording N times and report a spread
    // of zero, which is the opposite of what the measurement is for.
    expect(recordingKey({ ...base, sample: 1 })).not.toBe(recordingKey({ ...base, sample: 0 }));
    expect(recordingKey({ ...base, sample: 0 })).toBe(recordingKey(base));
  });
});

describe('vcrMode', () => {
  it('replays by default, so a re-run is free unless asked otherwise', () => {
    expect(vcrMode()).toBe('replay');
  });

  it('reads the three supported modes', () => {
    process.env.EVAL_VCR = 'record';
    expect(vcrMode()).toBe('record');
    process.env.EVAL_VCR = 'OFF';
    expect(vcrMode()).toBe('off');
    process.env.EVAL_VCR = 'replay';
    expect(vcrMode()).toBe('replay');
  });

  it('falls back to replay on anything unrecognised rather than silently calling the model', () => {
    process.env.EVAL_VCR = '1';
    expect(vcrMode()).toBe('replay');
  });
});
