import { listRuns } from '@/db/runs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ runs: await listRuns() });
}
