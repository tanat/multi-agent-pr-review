'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Decision, Run, StoredFinding } from '@/lib/schemas';

const MODELS = ['sonnet', 'gpt-4o', 'gemini-flash', 'gemini-pro'] as const;

const SEV_BORDER: Record<string, string> = {
  critical: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-yellow-500',
  low: 'border-l-gray-400',
};

const STATUS_LABEL: Record<string, string> = {
  reviewing: 'Specialists reviewing…',
  awaiting_approval: 'Awaiting your approval',
  publishing: 'Publishing…',
  done: 'Done',
  failed: 'Failed',
};

interface PublishResult {
  mode: string;
  body: string;
  url?: string;
  publishedCount: number;
}

export default function Home() {
  const [prUrl, setPrUrl] = useState('');
  const [model, setModel] = useState<(typeof MODELS)[number]>('sonnet');
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [findings, setFindings] = useState<StoredFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);

  const load = useCallback(async (id: string) => {
    const res = await fetch(`/api/runs/${id}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    setRun(data.run);
    setFindings(data.findings);
  }, []);

  // Initial load when a run starts.
  useEffect(() => {
    if (runId) load(runId);
  }, [runId, load]);

  // Poll while the run is in a transient state.
  useEffect(() => {
    if (!runId || !run) return;
    if (run.status !== 'reviewing' && run.status !== 'publishing') return;
    const t = setTimeout(() => load(runId), 1500);
    return () => clearTimeout(t);
  }, [runId, run, load]);

  async function startReview() {
    setError(null);
    setStarting(true);
    setRun(null);
    setFindings([]);
    setPublishResult(null);
    try {
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prUrl, model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'failed to start review');
      setRunId(data.runId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function decide(findingId: string, decision: Decision) {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ findingId, decision }),
    });
    load(runId);
  }

  async function decideAll(decision: Decision) {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ all: decision }),
    });
    load(runId);
  }

  async function publish() {
    if (!runId) return;
    const res = await fetch(`/api/runs/${runId}/publish`, { method: 'POST' });
    const data = await res.json();
    if (res.ok) setPublishResult(data);
    else setError(data.error ?? 'publish failed');
    load(runId);
  }

  async function resume() {
    if (!runId) return;
    await fetch(`/api/runs/${runId}/resume`, { method: 'POST' });
    load(runId);
  }

  const approvedCount = findings.filter((f) => f.decision === 'approved').length;
  const isReviewing = run?.status === 'reviewing';

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 font-sans">
      <h1 className="text-2xl font-semibold">Multi-agent PR Review</h1>
      <p className="mt-1 text-sm text-gray-500">
        Four specialists review a PR in parallel; you approve findings before they publish.
      </p>

      <div className="mt-6 flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-gray-300 px-3 py-2 text-sm"
          placeholder="https://github.com/owner/repo/pull/123"
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
        />
        <select
          className="rounded border border-gray-300 px-2 py-2 text-sm"
          value={model}
          onChange={(e) => setModel(e.target.value as (typeof MODELS)[number])}
        >
          {MODELS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          onClick={startReview}
          disabled={starting || !prUrl}
        >
          {starting ? 'Starting…' : 'Review'}
        </button>
      </div>

      {error && <p className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {run && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-medium">
                {run.owner}/{run.repo}#{run.number}
              </h2>
              <p className="text-sm text-gray-500">
                {STATUS_LABEL[run.status] ?? run.status} · {run.model}
                {isReviewing && <span className="ml-2 animate-pulse">●</span>}
              </p>
            </div>
            {(run.status === 'reviewing' || run.status === 'failed') && (
              <button className="rounded border px-3 py-1.5 text-sm" onClick={resume}>
                Resume
              </button>
            )}
          </div>

          {run.error && <p className="mt-2 rounded bg-red-50 p-3 text-sm text-red-700">{run.error}</p>}

          {findings.length > 0 && (
            <>
              <div className="mt-4 flex items-center gap-2 text-sm">
                <span className="text-gray-500">
                  {findings.length} findings · {approvedCount} approved
                </span>
                <span className="flex-1" />
                <button className="rounded border px-2 py-1" onClick={() => decideAll('approved')}>
                  Approve all
                </button>
                <button className="rounded border px-2 py-1" onClick={() => decideAll('rejected')}>
                  Reject all
                </button>
              </div>

              <ul className="mt-4 space-y-3">
                {findings.map((f) => (
                  <li
                    key={f.id}
                    className={`rounded border border-l-4 ${SEV_BORDER[f.severity]} p-3 ${
                      f.decision === 'rejected' ? 'opacity-50' : ''
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-wide text-gray-400">
                          {f.specialist} · {f.severity} · {f.file}
                          {f.line != null ? `:${f.line}` : ''}
                        </p>
                        <p className="font-medium">{f.title}</p>
                        <p className="mt-1 text-sm text-gray-600">{f.rationale}</p>
                        {f.suggestion && (
                          <p className="mt-1 text-sm text-gray-500">
                            <span className="font-medium">Suggestion:</span> {f.suggestion}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <button
                          className={`rounded px-2 py-1 text-xs ${
                            f.decision === 'approved' ? 'bg-green-600 text-white' : 'border'
                          }`}
                          onClick={() => decide(f.id, 'approved')}
                          aria-label="approve"
                        >
                          ✓
                        </button>
                        <button
                          className={`rounded px-2 py-1 text-xs ${
                            f.decision === 'rejected' ? 'bg-red-600 text-white' : 'border'
                          }`}
                          onClick={() => decide(f.id, 'rejected')}
                          aria-label="reject"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              {(run.status === 'awaiting_approval' || run.status === 'publishing') && (
                <button
                  className="mt-5 rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  onClick={publish}
                  disabled={approvedCount === 0}
                >
                  Publish {approvedCount} approved
                </button>
              )}
            </>
          )}

          {isReviewing && findings.length === 0 && (
            <p className="mt-4 text-sm text-gray-500">Specialists are reviewing the diff…</p>
          )}

          {publishResult && (
            <div className="mt-6">
              <p className="text-sm text-gray-500">
                Published {publishResult.publishedCount} (mode: {publishResult.mode})
                {publishResult.url && (
                  <>
                    {' · '}
                    <a className="underline" href={publishResult.url} target="_blank" rel="noreferrer">
                      view on GitHub
                    </a>
                  </>
                )}
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-gray-50 p-4 text-xs whitespace-pre-wrap">
                {publishResult.body}
              </pre>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
