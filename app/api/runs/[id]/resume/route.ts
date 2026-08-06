import { after } from 'next/server';
import { z } from 'zod';
import { resumeRun } from '@/lib/orchestrator';
import { REVIEW_RATE_LIMIT, clientKey, withinRateLimit } from '@/lib/guard';
import { langfuseSpanProcessor } from '@/instrumentation';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  /**
   * Re-review at the new head after the branch moved during the pause.
   *
   * Off by default: findings already stored point at line numbers in the commit
   * that was reviewed, so silently reviewing a different one leaves them
   * attached to code that has moved. Turning it on is the operator saying they
   * understand that.
   */
  acceptNewHead: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Resume re-runs specialists, so it spends the same way /api/review does.
  if (!withinRateLimit(clientKey(req))) {
    return Response.json({ error: `rate limit: ${REVIEW_RATE_LIMIT} per minute` }, { status: 429 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const acceptNewHead = parsed.success ? parsed.data.acceptNewHead === true : false;

  // Re-drive from the checkpoint after responding, same as the initial review.
  after(async () => {
    try {
      await resumeRun(id, undefined, { acceptNewHead });
    } catch (e) {
      // The reason is already recorded on the run row, where the UI reads it.
      console.error('resume failed:', e);
    } finally {
      await langfuseSpanProcessor.forceFlush();
    }
  });
  return Response.json({ ok: true });
}
