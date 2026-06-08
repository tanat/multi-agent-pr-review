import { after } from 'next/server';
import { resumeRun } from '@/lib/orchestrator';
import { langfuseSpanProcessor } from '@/instrumentation';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Re-drive from the checkpoint after responding, same as the initial review.
  after(async () => {
    try {
      await resumeRun(id);
    } catch (e) {
      console.error('resume failed:', e);
    } finally {
      await langfuseSpanProcessor.forceFlush();
    }
  });
  return Response.json({ ok: true });
}
