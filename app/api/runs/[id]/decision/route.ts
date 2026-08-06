import { z } from 'zod';
import { getRun, setAllDecisions, setDecision } from '@/db/runs';

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

  const run = await getRun(id);
  if (!run) return Response.json({ error: 'run not found' }, { status: 404 });

  // Triage is only meaningful while the run is waiting for it. Accepting a
  // decision on a finished run produced a state the product cannot act on: a
  // finding marked approved on a run whose publish step has already run, which
  // will never be posted and gives no indication of that.
  if (run.status !== 'awaiting_approval') {
    return Response.json(
      { error: `run is ${run.status}; decisions are only accepted while awaiting_approval` },
      { status: 409 },
    );
  }

  if ('all' in parsed.data) {
    await setAllDecisions(id, parsed.data.all);
  } else {
    const updated = await setDecision(id, parsed.data.findingId, parsed.data.decision);
    if (!updated) {
      return Response.json({ error: 'finding not found in this run' }, { status: 404 });
    }
  }
  return Response.json({ ok: true });
}
