import { publishRun } from '@/lib/orchestrator';
import { checkPublishAuth } from '@/lib/guard';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  // Output-only publishing renders Markdown into the page and stays open.
  // PUBLISH_MODE=github writes a comment on someone else's pull request under
  // the deployer's token, which is the only action here that leaves the system
  // — it does not get to be world-callable.
  const auth = checkPublishAuth(req);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  try {
    const result = await publishRun(id);
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 });
  }
}
