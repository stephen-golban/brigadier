# Security policy

## Reporting a vulnerability

Report a vulnerability privately, through one of these two channels:

- [GitHub Security Advisories](https://github.com/stephen-golban/brigadier/security/advisories/new)
  for this repository.
- Email golban.stephen@gmail.com.

Please do not open a public issue for a vulnerability.

This is a single-maintainer project. There is no response-time guarantee and
no bug bounty. Reports will be read and acted on as time allows.

## Supported versions

Only the latest released version is supported. The current version is 0.2.0.
There is no backport policy for older versions.

## What brigadier does and does not do with your credentials

brigadier never asks for, stores, or transmits model API credentials, and it
never talks to a model API directly. It spawns the `claude` and `codex` CLIs
you already have installed as ordinary subprocesses, under your existing
logins to those tools. If you are not logged in to a vendor CLI, brigadier
cannot use that vendor; it has no credential path of its own to fall back to.

## Secret redaction, and its limits

Redaction is **mandatory and not optional** once a worktree session has built
its inventory. Commit messages, diffs shown to reviewers, git output in error
messages, the reviewer's prompt, and paths and summaries returned by the
reviewer have inventoried secret values replaced with `[REDACTED]`, whether or
not you consented to anything.

Read this part carefully, because understating it would be worse than not
writing it at all:

**It defeats verbatim leaks only.** The inventory is a best-effort read of
raw, dotenv, JSON, and common YAML files, and it matches exact byte
sequences. A value a model transforms, summarizes, base64-encodes, splits, or
truncates is **not** caught. Do not treat redaction as a guarantee that a
secret cannot escape a worktree.

Planning happens before the inventory exists, so the task description you
give brigadier and the plan a model writes from it are **not** covered by
this redaction pass. Do not put secrets in a task description.

Making secret files *visible* to workers at all is a separate, explicit
consent recorded at `init`, defaulting to **No**. With consent off, no
configured secret file is linked into any worktree.

Consent governs *linking*, not visibility. Every file in your working tree
that git does not ignore — tracked or not — is captured into the base commit
each worktree is checked out from, whatever the consent setting says. A
`.env` committed to your repository, and an untracked `.env.local` you never
added, are both therefore present in the worker's worktree, byte for byte.
**The worker reads the real values.** Redaction replaces inventoried values
only in brigadier's own artifacts — commit messages, the diff and the prompt
the reviewer is given, the paths and summaries it returns, git output in
error messages — never in the file contents a worker opens, and always under
the verbatim-only limit above.

`--unsafe-in-place` bypasses worktree isolation and the linked-file
visibility boundary entirely: the worker runs in your own checkout, where
every file you can see is a file it can see, regardless of the consent
policy. It does not disable artifact redaction or the linked-secret commit
refusal.

## Scope

brigadier executes AI-generated code changes in git worktrees on your own
machine. It never pushes anywhere. The approval gate is your own merge of the
integration branch it produces — you review that branch the way you would
review any contributor's pull request, before anything reaches a remote.
