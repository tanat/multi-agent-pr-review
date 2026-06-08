import { Octokit } from '@octokit/rest';

export class InvalidPrUrlError extends Error {}

/** Parse a GitHub PR URL into { owner, repo, number }. */
export function parsePrUrl(url: string): { owner: string; repo: string; number: number } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!m) throw new InvalidPrUrlError(`Not a GitHub PR URL: ${url}`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

function octokit(token = process.env.GITHUB_TOKEN) {
  return new Octokit({ auth: token });
}

export interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface PrContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  author: string;
  files: PrFile[];
}

/** Fetch a PR's metadata and changed-file patches (read-only). */
export async function fetchPr(owner: string, repo: string, number: number): Promise<PrContext> {
  const gh = octokit();
  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: number });
  const files = await gh.paginate(gh.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  });
  return {
    owner,
    repo,
    number,
    title: pr.title,
    body: pr.body ?? null,
    author: pr.user?.login ?? 'unknown',
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}

/** Render the PR's diff into a compact, prompt-friendly string. */
export function renderDiff(ctx: PrContext, maxPatchChars = 6000): string {
  const parts: string[] = [`PR #${ctx.number}: ${ctx.title}`, `Author: ${ctx.author}`, ''];
  if (ctx.body) parts.push(`Description:\n${ctx.body.slice(0, 1000)}`, '');
  for (const f of ctx.files) {
    parts.push(`--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---`);
    parts.push(f.patch ? f.patch.slice(0, maxPatchChars) : '(no textual patch — binary or too large)');
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Post approved findings as a PR comment. Mutating — only called when the user
 * explicitly opts in (PUBLISH_MODE=github + a write-scoped token). Default
 * publish mode is output-only.
 */
export async function postReviewComment(
  owner: string,
  repo: string,
  number: number,
  body: string,
  token = process.env.GITHUB_WRITE_TOKEN,
): Promise<{ url: string }> {
  if (!token) throw new Error('GITHUB_WRITE_TOKEN is required to post real PR comments');
  const gh = octokit(token);
  const { data } = await gh.rest.issues.createComment({
    owner,
    repo,
    issue_number: number,
    body,
  });
  return { url: data.html_url };
}
