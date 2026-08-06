-- Durability, take two.
--
-- The first migration made the run resumable in the sense that its data
-- survived a restart. It did not make the transitions safe:
--
--   * `failed` recorded that a run died but never where, so resume guessed the
--     review stage and a publish failure silently rewound the run to
--     awaiting_approval with its error erased;
--   * status was written with a blind UPDATE, so two concurrent publishes both
--     passed the status check and both posted;
--   * the GitHub comment was posted before the rows were marked published, so a
--     crash in that window left a live comment and rows that said otherwise —
--     and the retry posted a second one;
--   * the run never recorded which commit it reviewed, so a push during the
--     human pause meant resuming onto a different diff;
--   * the model was passed as an argument and defaulted to sonnet on resume, so
--     a gemini run silently finished on Claude while `model` still said gemini.

set search_path = public;

alter table runs add column if not exists head_sha text;

-- Where a failed run died, so resume returns to that stage instead of guessing.
alter table runs add column if not exists failed_stage text
  check (failed_stage is null or failed_stage in ('reviewing', 'publishing'));

-- The model key the run was started with. `model` holds the display id; this
-- holds the key resume needs to reach the same model.
alter table runs add column if not exists model_key text;

-- One publish attempt per run. Written before the comment is posted and echoed
-- into the comment body, so a retry can recognise its own earlier post on
-- GitHub instead of adding a second one.
alter table runs add column if not exists publish_attempt_id uuid;
alter table runs add column if not exists published_comment_url text;

-- Last sign of life from a run that claims to be working. A run stuck in
-- 'reviewing' with an old heartbeat died; nothing else distinguishes it from
-- one that is simply slow.
alter table runs add column if not exists heartbeat_at timestamptz;

create index if not exists idx_runs_heartbeat on runs (status, heartbeat_at)
  where status in ('reviewing', 'publishing');
