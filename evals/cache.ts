import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Finding, Specialist } from '@/lib/schemas';
import type { Usage } from '@/lib/models';

/**
 * Recorded specialist runs, so changing how findings are scored, deduped or
 * merged costs nothing to re-measure.
 *
 * Without this, every scorer tweak means four model calls per fixture and a
 * wait — which is the reason a scorer nobody could afford to re-run went
 * unexamined long enough to report a recall of 1.000. The recording holds the
 * raw findings each specialist returned; everything downstream of the model is
 * recomputed on replay, so a matcher change is measured against the same
 * generations rather than against fresh ones that moved for other reasons.
 *
 * Modes (EVAL_VCR):
 *   replay (default) — use a recording when there is one, call the model when
 *                      there is not, and record what comes back
 *   record           — always call the model and overwrite the recording
 *   off              — always call the model, never touch the cache
 */
export type VcrMode = 'replay' | 'record' | 'off';

export function vcrMode(): VcrMode {
  const raw = (process.env.EVAL_VCR ?? 'replay').toLowerCase();
  return raw === 'record' || raw === 'off' ? raw : 'replay';
}

export interface Recording {
  key: string;
  model: string;
  promptVersion: string;
  fixture: string;
  specialist: Specialist;
  sample: number;
  recordedAt: string;
  findings: Finding[];
  latencyMs: number;
  /** Optional so recordings made before token capture still replay. */
  usage?: Usage;
}

export interface RecordingKeyInput {
  model: string;
  promptVersion: string;
  fixture: string;
  specialist: Specialist;
  sample?: number;
  /** Hashed in so an edited fixture cannot silently replay the old diff's answer. */
  diff: string;
}

const DIR = path.join(process.cwd(), 'evals', 'cache');

export function recordingKey(input: RecordingKeyInput): string {
  const parts = [
    input.model,
    input.promptVersion,
    input.fixture,
    input.specialist,
    String(input.sample ?? 0),
    createHash('sha256').update(input.diff).digest('hex').slice(0, 12),
  ];
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 24);
}

function fileFor(key: string): string {
  return path.join(DIR, `${key}.json`);
}

export function readRecording(key: string): Recording | null {
  try {
    const raw = fs.readFileSync(fileFor(key), 'utf8');
    const parsed = JSON.parse(raw) as Recording;
    return Array.isArray(parsed.findings) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeRecording(rec: Recording): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(fileFor(rec.key), JSON.stringify(rec, null, 2) + '\n');
}

/**
 * Run `live` unless a recording answers for it. Returns the findings plus
 * whether they came off disk, so the harness can report how much of a run was
 * replayed instead of quietly presenting cached numbers as fresh ones.
 */
export async function withRecording(
  input: RecordingKeyInput,
  live: () => Promise<{ findings: Finding[]; latencyMs: number; usage: Usage }>,
): Promise<{ findings: Finding[]; latencyMs: number; usage: Usage | null; cached: boolean }> {
  const mode = vcrMode();
  const key = recordingKey(input);

  if (mode === 'replay') {
    const hit = readRecording(key);
    if (hit) {
      return { findings: hit.findings, latencyMs: hit.latencyMs, usage: hit.usage ?? null, cached: true };
    }
  }

  const { findings, latencyMs, usage } = await live();

  if (mode !== 'off') {
    writeRecording({
      key,
      model: input.model,
      promptVersion: input.promptVersion,
      fixture: input.fixture,
      specialist: input.specialist,
      sample: input.sample ?? 0,
      recordedAt: new Date().toISOString(),
      findings,
      latencyMs,
      usage,
    });
  }

  return { findings, latencyMs, usage, cached: false };
}
