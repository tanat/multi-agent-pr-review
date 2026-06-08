import { z } from 'zod';
import { setAllDecisions, setDecision } from '@/db/runs';

export const runtime = 'nodejs';

const Body = z.union([
  z.object({ findingId: z.string().min(1), decision: z.enum(['approved', 'rejected', 'pending']) }),
  z.object({ all: z.enum(['approved', 'rejected', 'pending']) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'expected { findingId, decision } or { all: decision }' },
      { status: 400 },
    );
  }
  if ('all' in parsed.data) {
    await setAllDecisions(id, parsed.data.all);
  } else {
    await setDecision(parsed.data.findingId, parsed.data.decision);
  }
  return Response.json({ ok: true });
}
