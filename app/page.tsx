'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Decision, Run, StoredFinding } from '@/lib/schemas';

const MODELS = ['sonnet', 'gpt-4o', 'gemini-flash', 'gemini-pro'] as const;

/* ---- presentation-only metadata (no behavior) ---- */

const SPECIALIST_ORDER = ['security', 'correctness', 'tests', 'style'] as const;

const SPECIALIST_META: Record<
  string,
  { label: string; blurb: string; icon: string; accent: string; ring: string }
> = {
  security: {
    label: 'Security',
    blurb: 'Injection, secrets, authz, unsafe input',
    icon: 'M12 2 4 5v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V5l-8-3Z',
    accent: 'text-rose-300',
    ring: 'ring-rose-500/20 bg-rose-500/10',
  },
  correctness: {
    label: 'Correctness',
    blurb: 'Logic bugs, races, edge cases',
    icon: 'm5 13 4 4L19 7',
    accent: 'text-emerald-300',
    ring: 'ring-emerald-500/20 bg-emerald-500/10',
  },
  tests: {
    label: 'Tests',
    blurb: 'Missing coverage, weak assertions',
    icon: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2',
    accent: 'text-sky-300',
    ring: 'ring-sky-500/20 bg-sky-500/10',
  },
  style: {
    label: 'Style',
    blurb: 'Readability, naming, conventions',
    icon: 'M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5zM2 2l7.586 7.586M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    accent: 'text-violet-300',
    ring: 'ring-violet-500/20 bg-violet-500/10',
  },
};

const SEV_META: Record<
  string,
  { label: string; badge: string; bar: string; dot: string; rank: number }
> = {
  critical: {
    label: 'Critical',
    badge: 'bg-red-500/15 text-red-300 ring-1 ring-inset ring-red-500/30',
    bar: 'bg-red-500',
    dot: 'bg-red-400',
    rank: 0,
  },
  high: {
    label: 'High',
    badge: 'bg-orange-500/15 text-orange-300 ring-1 ring-inset ring-orange-500/30',
    bar: 'bg-orange-500',
    dot: 'bg-orange-400',
    rank: 1,
  },
  medium: {
    label: 'Medium',
    badge: 'bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-500/30',
    bar: 'bg-amber-500',
    dot: 'bg-amber-400',
    rank: 2,
  },
  low: {
    label: 'Low',
    badge: 'bg-slate-500/15 text-slate-300 ring-1 ring-inset ring-slate-500/30',
    bar: 'bg-slate-500',
    dot: 'bg-slate-400',
    rank: 3,
  },
};

const STATUS_META: Record<
  string,
  { label: string; tone: string; spin: boolean; pulse?: boolean }
> = {
  reviewing: {
    label: 'Specialists reviewing',
    tone: 'bg-indigo-500/15 text-indigo-200 ring-1 ring-inset ring-indigo-400/30',
    spin: true,
  },
  awaiting_approval: {
    label: 'Awaiting your approval',
    tone: 'bg-amber-500/15 text-amber-200 ring-1 ring-inset ring-amber-400/30',
    spin: false,
    pulse: true,
  },
  publishing: {
    label: 'Publishing',
    tone: 'bg-sky-500/15 text-sky-200 ring-1 ring-inset ring-sky-400/30',
    spin: true,
  },
  done: {
    label: 'Done',
    tone: 'bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-400/30',
    spin: false,
  },
  failed: {
    label: 'Failed',
    tone: 'bg-red-500/15 text-red-200 ring-1 ring-inset ring-red-400/30',
    spin: false,
  },
};

function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
      <path
        className="opacity-90"
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SpecialistIcon({ name, className = '' }: { name: string; className?: string }) {
  const meta = SPECIALIST_META[name];
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={meta?.icon ?? ''} />
    </svg>
  );
}

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
  const rejectedCount = findings.filter((f) => f.decision === 'rejected').length;
  const isReviewing = run?.status === 'reviewing';
  const status = run ? STATUS_META[run.status] : null;

  // Group findings by specialist, severity-sorted within each group (presentation only).
  const grouped = SPECIALIST_ORDER.map((name) => ({
    name,
    items: findings
      .filter((f) => f.specialist === name)
      .slice()
      .sort((a, b) => (SEV_META[a.severity]?.rank ?? 9) - (SEV_META[b.severity]?.rank ?? 9)),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-full flex-col">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-white/10 bg-[#0a0b10]/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-3.5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-lg shadow-indigo-500/20">
              <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" aria-hidden="true">
                <path
                  d="M9 3H5a2 2 0 0 0-2 2v4m0 6v4a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2v-4m0-6V5a2 2 0 0 0-2-2h-4M8 12l3 3 5-6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <div className="leading-tight">
              <div className="text-sm font-semibold tracking-tight">Multi-agent PR Review</div>
              <div className="text-[11px] text-slate-400">Four specialists · human-in-the-loop</div>
            </div>
          </div>
          <a
            href="https://github.com/sindresorhus/p-map/pull/77"
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs text-slate-300 transition hover:border-white/25 hover:text-white sm:inline-flex"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            Demo PR
          </a>
        </div>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-5 py-8 sm:px-6 sm:py-10">
        {/* Hero */}
        <div className="max-w-2xl">
          <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
            Review a pull request with a team of agents
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Paste a GitHub PR URL. Four specialist agents — security, correctness, tests and style —
            review the diff in parallel. You approve the findings worth keeping, then publish a clean
            review comment.
          </p>
        </div>

        {/* Specialist legend */}
        <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {SPECIALIST_ORDER.map((name) => {
            const m = SPECIALIST_META[name];
            return (
              <div
                key={name}
                className="rounded-xl border border-white/10 bg-white/[0.03] p-3 transition hover:border-white/20"
              >
                <div className="flex items-center gap-2">
                  <span className={`grid h-7 w-7 place-items-center rounded-lg ring-1 ${m.ring}`}>
                    <SpecialistIcon name={name} className={`h-4 w-4 ${m.accent}`} />
                  </span>
                  <span className="text-sm font-medium text-slate-100">{m.label}</span>
                </div>
                <p className="mt-2 text-[11px] leading-snug text-slate-400">{m.blurb}</p>
              </div>
            );
          })}
        </div>

        {/* Input panel */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-xl shadow-black/20 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">
                <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                  <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
                </svg>
              </span>
              <input
                className="w-full rounded-xl border border-white/10 bg-[#0c0e15] py-2.5 pl-9 pr-3 text-sm text-slate-100 placeholder:text-slate-500 transition focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                placeholder="https://github.com/owner/repo/pull/123"
                value={prUrl}
                onChange={(e) => setPrUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && prUrl && !starting) startReview();
                }}
              />
            </div>

            <div className="flex items-stretch gap-3">
              <div className="relative">
                <select
                  className="h-full appearance-none rounded-xl border border-white/10 bg-[#0c0e15] py-2.5 pl-3 pr-8 text-sm text-slate-100 transition focus:border-indigo-400/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  value={model}
                  onChange={(e) => setModel(e.target.value as (typeof MODELS)[number])}
                  aria-label="Model"
                >
                  {MODELS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500">
                  <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                    <path d="M5.5 7.5 10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </div>

              <button
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-indigo-400/60 focus:ring-offset-2 focus:ring-offset-[#0a0b10] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                onClick={startReview}
                disabled={starting || !prUrl}
              >
                {starting ? (
                  <>
                    <Spinner className="h-4 w-4" />
                    Starting
                  </>
                ) : (
                  <>
                    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                      <path d="M6.3 3.6a1 1 0 0 0-1.5.87v11.06a1 1 0 0 0 1.5.87l9.2-5.53a1 1 0 0 0 0-1.74L6.3 3.6Z" />
                    </svg>
                    Review
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-sm text-red-200">
            <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
              <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm0 9.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        {/* Empty state */}
        {!run && !starting && (
          <div className="mt-8 rounded-2xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-12 text-center">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-white/5 text-slate-400">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M9 12h6m-6 4h4M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="mt-4 text-sm font-medium text-slate-200">No review yet</p>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-slate-500">
              Paste a pull request URL above and hit Review to fan out the specialist agents.
            </p>
          </div>
        )}

        {run && (
          <section className="mt-8 animate-fade-rise">
            {/* Run header */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
              <div className="min-w-0">
                <a
                  href={run.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="group inline-flex items-center gap-2 text-base font-semibold text-white"
                >
                  <span className="truncate">
                    {run.owner}/{run.repo}
                    <span className="text-slate-500"> #{run.number}</span>
                  </span>
                  <svg viewBox="0 0 20 20" className="h-3.5 w-3.5 text-slate-500 transition group-hover:text-slate-300" fill="currentColor" aria-hidden="true">
                    <path d="M7 4h9v9h-2V7.4l-8.3 8.3-1.4-1.4L12.6 6H7V4Z" />
                  </svg>
                </a>
                {run.title && <p className="mt-0.5 truncate text-sm text-slate-400">{run.title}</p>}
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                    {run.model}
                  </span>
                </p>
              </div>

              <div className="flex items-center gap-2">
                {status && (
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium ${status.tone}`}>
                    {status.spin ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <span
                        className={`h-1.5 w-1.5 rounded-full bg-current ${status.pulse ? 'animate-pulse' : ''}`}
                      />
                    )}
                    {status.label}
                  </span>
                )}
                {(run.status === 'reviewing' || run.status === 'failed') && (
                  <button
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/25 hover:bg-white/5 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                    onClick={resume}
                  >
                    <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                      <path d="M4 4v5h5L6.6 6.6A6 6 0 1 1 4 11h2a4 4 0 1 0 1.2-2.8L4 4Z" />
                    </svg>
                    Resume
                  </button>
                )}
              </div>
            </div>

            {run.error && (
              <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-red-500/30 bg-red-500/10 p-3.5 text-sm text-red-200">
                <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0" fill="currentColor" aria-hidden="true">
                  <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 4a1 1 0 0 1 1 1v4a1 1 0 1 1-2 0V6a1 1 0 0 1 1-1Zm0 9.5a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5Z" />
                </svg>
                <span>{run.error}</span>
              </div>
            )}

            {findings.length > 0 && (
              <>
                {/* Bulk actions bar */}
                <div className="sticky top-[57px] z-10 mt-5 flex flex-wrap items-center gap-3 rounded-xl border border-white/10 bg-[#0c0e15]/85 px-3.5 py-2.5 backdrop-blur-md">
                  <div className="flex items-center gap-3 text-sm">
                    <span className="font-medium text-slate-200">{findings.length} findings</span>
                    <span className="hidden h-3.5 w-px bg-white/10 sm:block" />
                    <span className="inline-flex items-center gap-1.5 text-emerald-300">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                      {approvedCount} approved
                    </span>
                    {rejectedCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 text-slate-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                        {rejectedCount} rejected
                      </span>
                    )}
                  </div>
                  <span className="flex-1" />
                  <div className="flex items-center gap-2">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                      onClick={() => decideAll('approved')}
                    >
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                        <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z" />
                      </svg>
                      Approve all
                    </button>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-slate-500/40"
                      onClick={() => decideAll('rejected')}
                    >
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                        <path d="M6.2 4.8 10 8.6l3.8-3.8 1.4 1.4L11.4 10l3.8 3.8-1.4 1.4L10 11.4l-3.8 3.8-1.4-1.4L8.6 10 4.8 6.2l1.4-1.4Z" />
                      </svg>
                      Reject all
                    </button>
                  </div>
                </div>

                {/* Findings grouped by specialist */}
                <div className="mt-5 space-y-6">
                  {grouped.map((group) => {
                    const m = SPECIALIST_META[group.name];
                    return (
                      <div key={group.name}>
                        <div className="mb-2.5 flex items-center gap-2">
                          <span className={`grid h-6 w-6 place-items-center rounded-md ring-1 ${m.ring}`}>
                            <SpecialistIcon name={group.name} className={`h-3.5 w-3.5 ${m.accent}`} />
                          </span>
                          <h3 className="text-sm font-semibold text-slate-100">{m.label}</h3>
                          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-slate-400">
                            {group.items.length}
                          </span>
                        </div>

                        <ul className="space-y-2.5">
                          {group.items.map((f) => {
                            const sev = SEV_META[f.severity];
                            const approved = f.decision === 'approved';
                            const rejected = f.decision === 'rejected';
                            return (
                              <li
                                key={f.id}
                                className={`group relative overflow-hidden rounded-xl border bg-white/[0.03] transition ${
                                  approved
                                    ? 'border-emerald-500/30 bg-emerald-500/[0.04]'
                                    : rejected
                                      ? 'border-white/5 opacity-55'
                                      : 'border-white/10 hover:border-white/20'
                                }`}
                              >
                                <span className={`absolute inset-y-0 left-0 w-1 ${sev?.bar ?? 'bg-slate-500'}`} />
                                <div className="flex items-start justify-between gap-3 p-4 pl-5">
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${sev?.badge}`}>
                                        {sev?.label ?? f.severity}
                                      </span>
                                      <span className="inline-flex items-center gap-1 font-mono text-[11px] text-slate-400">
                                        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                                          <path d="M9 1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5L9 1Zm0 1.5L11.5 5H9V2.5Z" />
                                        </svg>
                                        {f.file}
                                        {f.line != null ? `:${f.line}` : ''}
                                      </span>
                                    </div>
                                    <p className="mt-1.5 text-sm font-medium leading-snug text-slate-100">
                                      {f.title}
                                    </p>
                                    <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
                                      {f.rationale}
                                    </p>
                                    {f.suggestion && (
                                      <div className="mt-2.5 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                                        <p className="text-[13px] leading-relaxed text-slate-300">
                                          <span className="mr-1.5 inline-flex items-center gap-1 font-medium text-indigo-300">
                                            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                                              <path d="M10 2a6 6 0 0 0-3.6 10.8c.4.3.6.6.6 1V15a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1v-1.2c0-.4.2-.7.6-1A6 6 0 0 0 10 2ZM8 18h4v1H8v-1Z" />
                                            </svg>
                                            Suggestion
                                          </span>
                                          {f.suggestion}
                                        </p>
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex shrink-0 items-center gap-1.5">
                                    <button
                                      className={`grid h-8 w-8 place-items-center rounded-lg transition focus:outline-none focus:ring-2 focus:ring-emerald-500/50 ${
                                        approved
                                          ? 'bg-emerald-500 text-white shadow-md shadow-emerald-500/30'
                                          : 'border border-white/10 text-slate-400 hover:border-emerald-500/40 hover:text-emerald-300'
                                      }`}
                                      onClick={() => decide(f.id, 'approved')}
                                      aria-label="Approve finding"
                                      aria-pressed={approved}
                                      title="Approve"
                                    >
                                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                                        <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.1 3.1 6.8-6.8a1 1 0 0 1 1.4 0Z" />
                                      </svg>
                                    </button>
                                    <button
                                      className={`grid h-8 w-8 place-items-center rounded-lg transition focus:outline-none focus:ring-2 focus:ring-red-500/50 ${
                                        rejected
                                          ? 'bg-red-500 text-white shadow-md shadow-red-500/30'
                                          : 'border border-white/10 text-slate-400 hover:border-red-500/40 hover:text-red-300'
                                      }`}
                                      onClick={() => decide(f.id, 'rejected')}
                                      aria-label="Reject finding"
                                      aria-pressed={rejected}
                                      title="Reject"
                                    >
                                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                                        <path d="M6.2 4.8 10 8.6l3.8-3.8 1.4 1.4L11.4 10l3.8 3.8-1.4 1.4L10 11.4l-3.8 3.8-1.4-1.4L8.6 10 4.8 6.2l1.4-1.4Z" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    );
                  })}
                </div>

                {(run.status === 'awaiting_approval' || run.status === 'publishing') && (
                  <div className="mt-6 flex items-center gap-3">
                    <button
                      className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-indigo-400/60 focus:ring-offset-2 focus:ring-offset-[#0a0b10] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
                      onClick={publish}
                      disabled={approvedCount === 0}
                    >
                      {run.status === 'publishing' ? (
                        <Spinner className="h-4 w-4" />
                      ) : (
                        <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                          <path d="M3.4 9.6 16.7 3a1 1 0 0 1 1.3 1.3l-6.6 13.3a1 1 0 0 1-1.85-.1l-1.5-4.6-4.6-1.5a1 1 0 0 1-.1-1.85Z" />
                        </svg>
                      )}
                      Publish {approvedCount} approved
                    </button>
                    {approvedCount === 0 && (
                      <span className="text-xs text-slate-500">Approve at least one finding to publish.</span>
                    )}
                  </div>
                )}
              </>
            )}

            {/* Loading skeletons while reviewing */}
            {isReviewing && findings.length === 0 && (
              <div className="mt-6 space-y-2.5">
                <p className="mb-3 inline-flex items-center gap-2 text-sm text-slate-400">
                  <Spinner className="h-4 w-4 text-indigo-300" />
                  Specialists are reviewing the diff…
                </p>
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="animate-shimmer relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] p-4"
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-16 rounded bg-white/10" />
                      <div className="h-4 w-28 rounded bg-white/5" />
                    </div>
                    <div className="mt-3 h-4 w-3/4 rounded bg-white/10" />
                    <div className="mt-2 h-3 w-full rounded bg-white/5" />
                    <div className="mt-1.5 h-3 w-2/3 rounded bg-white/5" />
                  </div>
                ))}
              </div>
            )}

            {/* Published comment */}
            {publishResult && (
              <div className="mt-7 animate-fade-rise overflow-hidden rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04]">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-white/[0.02] px-4 py-3">
                  <div className="inline-flex items-center gap-2 text-sm font-medium text-emerald-200">
                    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="currentColor" aria-hidden="true">
                      <path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm4.2 6.7-5 5a1 1 0 0 1-1.4 0l-2-2a1 1 0 1 1 1.4-1.4l1.3 1.3 4.3-4.3a1 1 0 0 1 1.4 1.4Z" />
                    </svg>
                    Published {publishResult.publishedCount} finding
                    {publishResult.publishedCount === 1 ? '' : 's'}
                    <span className="rounded-md bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                      {publishResult.mode}
                    </span>
                  </div>
                  {publishResult.url && (
                    <a
                      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium text-slate-200 transition hover:border-white/25 hover:bg-white/5"
                      href={publishResult.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      View on GitHub
                      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
                        <path d="M7 4h9v9h-2V7.4l-8.3 8.3-1.4-1.4L12.6 6H7V4Z" />
                      </svg>
                    </a>
                  )}
                </div>
                <pre className="scrollbar-thin max-h-96 overflow-auto whitespace-pre-wrap p-4 font-mono text-[12px] leading-relaxed text-slate-300">
                  {publishResult.body}
                </pre>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4 text-[11px] text-slate-500 sm:px-6">
          <span>Multi-agent orchestration · human-in-the-loop · durable runs</span>
          <span className="font-mono">Vercel AI SDK</span>
        </div>
      </footer>
    </div>
  );
}
