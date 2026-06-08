import { getFindings, getRun } from '@/db/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const run = await getRun(id);
  if (!run) return Response.json({ error: 'run not found' }, { status: 404 });
  const findings = await getFindings(id);
  return Response.json({ run, findings });
}
