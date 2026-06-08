import { after } from 'next/server';
import { z } from 'zod';
import { createReview, reviewRun } from '@/lib/orchestrator';
import { InvalidPrUrlError } from '@/lib/github';
import { MODEL_IDS, type ModelKey } from '@/lib/models';
import { langfuseSpanProcessor } from '@/instrumentation';

export const runtime = 'nodejs';
export const maxDuration = 300;

const Body = z.object({
  prUrl: z.string().min(1),
  model: z.string().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'expected { prUrl: string, model?: string }' }, { status: 400 });
  }
  const modelKey: ModelKey =
    parsed.data.model && parsed.data.model in MODEL_IDS ? (parsed.data.model as ModelKey) : 'sonnet';

  try {
    const runId = await createReview(parsed.data.prUrl, modelKey);
    // Respond with the runId immediately; drive the (slow) multi-agent review
    // after the response. If this invocation is cut short, the run stays at
    // 'reviewing' and POST /api/runs/[id]/resume finishes it from the checkpoint.
    after(async () => {
      try {
        await reviewRun(runId, modelKey);
      } catch (e) {
        console.error('review failed:', e);
      } finally {
        await langfuseSpanProcessor.forceFlush();
      }
    });
    return Response.json({ runId });
  } catch (err) {
    if (err instanceof InvalidPrUrlError) {
      return Response.json({ error: err.message }, { status: 400 });
    }
    console.error('create review failed:', err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
