import { generateObject } from 'ai';
import { SpecialistOutput, type Finding, type Specialist } from './schemas';
import { modelFor, type ModelKey } from './models';

/**
 * Bumped whenever a lens or the shared instruction below changes. It is part of
 * the eval cache key, so editing a prompt invalidates every recording made
 * under the old wording instead of silently scoring new prompts against old
 * generations.
 */
export const SPECIALIST_PROMPT_VERSION = 'v1.0.0' as const;

/**
 * Each specialist reviews the SAME diff through a different lens. They run in
 * parallel (see the orchestrator) and never see each other's output — the
 * orchestrator merges and dedups afterwards.
 */
const LENS: Record<Specialist, string> = {
  security:
    'You are a security reviewer. Flag ONLY security issues: injection (SQL/command/path), ' +
    'secrets or credentials committed, missing authz/authn, unsafe deserialization, SSRF, XSS, ' +
    'insecure crypto/randomness, or unvalidated input crossing a trust boundary.',
  correctness:
    'You are a correctness reviewer. Flag ONLY behavioural bugs: logic errors, off-by-one, ' +
    'null/undefined handling, race conditions, wrong or missing error handling, broken edge ' +
    'cases, and regressions implied by the change.',
  tests:
    'You are a test-coverage reviewer. Flag ONLY testing gaps: new or changed behaviour with no ' +
    'test, missing edge-case coverage, assertions that do not actually exercise the change, and ' +
    'flaky patterns.',
  style:
    'You are a maintainability reviewer. Flag ONLY maintainability issues: poor naming, dead code, ' +
    'excessive complexity, duplication, leaky/unclear abstractions, missing types. Do NOT flag ' +
    'pure formatting — a formatter handles that.',
};

const SHARED =
  'Review ONLY the diff provided — never invent issues in code you cannot see. For each issue ' +
  'return the file path, the 1-based line in the new file (or null), a severity, a one-line ' +
  'title, a rationale grounded in the diff, and a concrete suggestion (or null). Be skeptical: ' +
  'a false positive is worse than a missed nit. Return an empty findings array if your lens ' +
  'turns up nothing. At most 20 findings, highest severity first.';

/** Run one specialist over the diff and return its findings (structured). */
export async function runSpecialist(
  specialist: Specialist,
  diff: string,
  modelKey: ModelKey,
  runId: string,
): Promise<Finding[]> {
  const { object } = await generateObject({
    model: modelFor(modelKey),
    schema: SpecialistOutput,
    system: `${LENS[specialist]}\n\n${SHARED}`,
    prompt: `Review this pull request diff as the ${specialist} specialist:\n\n${diff}`,
    // One trace per specialist; the orchestrator groups them under the run's
    // sessionId via propagateAttributes (see lib/orchestrator.ts).
    experimental_telemetry: {
      isEnabled: true,
      functionId: `specialist-${specialist}`,
      metadata: { runId, specialist, modelKey },
    },
  });
  return object.findings;
}
