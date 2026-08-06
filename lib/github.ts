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
  /**
   * The commit the review is of.
   *
   * The project's claim is that a run survives an hours-long human pause and
   * resumes from its checkpoint — but the checkpoint never recorded *what* was
   * being reviewed. Push during the pause and a resume fetches the new head,
   * re-reviews a different diff, and leaves already-stored findings pointing at
   * line numbers that have moved. Silently.
   */
  headSha: string;
  title: string;
  body: string | null;
  author: string;
  files: PrFile[];
  /** True when the PR has more changed files than were fetched. */
  truncatedFileList?: boolean;
}

/** Pages of 100 changed files to fetch before giving up on a very large PR. */
export const MAX_FILE_PAGES = 3;

/** Per-file patch budget. */
export const MAX_PATCH_CHARS = 6000;

/**
 * Whole-diff budget.
 *
 * The per-file cap alone bounds nothing: `paginate` walked every page, so a
 * 300-file PR built roughly 1.8 million characters and handed the same string
 * to four models at once. The aggregate budget is what actually protects the
 * request; the per-file cap only stops one enormous file from eating it.
 */
export const MAX_DIFF_CHARS = 60_000;

/** Fetch a PR's metadata and changed-file patches (read-only). */
export async function fetchPr(owner: string, repo: string, number: number): Promise<PrContext> {
  const gh = octokit();
  const { data: pr } = await gh.rest.pulls.get({ owner, repo, pull_number: number });

  const files: PrFile[] = [];
  let pages = 0;
  let truncatedFileList = false;
  for await (const page of gh.paginate.iterator(gh.rest.pulls.listFiles, {
    owner,
    repo,
    pull_number: number,
    per_page: 100,
  })) {
    files.push(
      ...page.data.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch,
      })),
    );
    if (++pages >= MAX_FILE_PAGES) {
      truncatedFileList = page.data.length === 100;
      break;
    }
  }

  return {
    owner,
    repo,
    number,
    headSha: pr.head.sha,
    title: pr.title,
    body: pr.body ?? null,
    author: pr.user?.login ?? 'unknown',
    files,
    truncatedFileList,
  };
}

/**
 * Render the PR's diff into a compact, prompt-friendly string.
 *
 * Every cut is announced. A specialist reviewing a patch that was silently
 * sliced at 6000 characters reports on a fraction of the file with full
 * confidence, and nothing downstream — not the finding, not the run, not the
 * eval — records that it happened. Saying so in the text is the cheapest
 * possible fix: the model can hedge, and a reader of the trace can see it.
 */
export function renderDiff(
  ctx: PrContext,
  maxPatchChars = MAX_PATCH_CHARS,
  maxDiffChars = MAX_DIFF_CHARS,
): string {
  const parts: string[] = [`PR #${ctx.number}: ${ctx.title}`, `Author: ${ctx.author}`, ''];
  if (ctx.body) {
    const body = ctx.body.length > 1000 ? `${ctx.body.slice(0, 1000)}\n[description truncated]` : ctx.body;
    parts.push(`Description:\n${body}`, '');
  }
  if (ctx.truncatedFileList) {
    parts.push(
      `[NOTE: this PR has more changed files than were fetched; only the first ${ctx.files.length} are shown]`,
      '',
    );
  }

  let budget = maxDiffChars;
  let filesOmitted = 0;

  for (const f of ctx.files) {
    const header = `--- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) ---`;
    if (budget <= header.length) {
      filesOmitted += 1;
      continue;
    }
    parts.push(header);
    budget -= header.length;

    if (!f.patch) {
      parts.push('(no textual patch — binary or too large)');
    } else {
      const limit = Math.min(maxPatchChars, budget);
      if (f.patch.length > limit) {
        parts.push(f.patch.slice(0, limit));
        parts.push(`[patch truncated: ${f.patch.length - limit} of ${f.patch.length} characters not shown]`);
      } else {
        parts.push(f.patch);
      }
      budget -= Math.min(f.patch.length, limit);
    }
    parts.push('');
  }

  if (filesOmitted > 0) {
    parts.push(`[NOTE: ${filesOmitted} more changed file(s) omitted — the diff exceeded the review budget]`, '');
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
