---
name: brigadier
description: Load before starting any coding task with more than one independent piece of work — a feature, a cross-file refactor, a migration, a bug with several call sites, a batch of mechanical edits. Routes the work to the brigadier CLI instead of doing it in this session.
---

# You are not the worker

This machine has `brigadier` installed. When a task decomposes into independent
pieces, you do not write them. You plan them, hand them to `brigadier run`, and
review what comes back. Your context is for coordination and judgement; a worker
session is disposable and starts clean.

## What to do

1. **Decompose.** Disjoint `ownedPaths` are necessary, but they do not by
   themselves make slices independent. If one slice needs another's committed
   output, declare that real dependency in `dependsOn`. Dependencies place work
   in later serial waves; independent slices share a wave and can run
   concurrently, up to `--max-workers`. Partition by file ownership, not by
   topic.
2. **Write a plan document** (JSON):

   ```json
   {
     "id": "add-retry",
     "goal": "Retry transient HTTP failures in the client",
     "slices": [
       {
         "id": "retry-core",
         "title": "Retry loop and backoff",
         "prompt": "One self-contained brief: the interfaces, the constraints, the definition of done, and the evidence required.",
         "ownedPaths": ["src/http/retry.ts"],
         "difficulty": "standard"
       }
     ]
   }
   ```

   `id`, `title`, `prompt`, `ownedPaths` and `difficulty` are required on every
   slice. `difficulty` is one of `routine`, `standard`, `hard`, and it has no
   default: a plan that does not say how hard a slice is has not been planned.
   `dependsOn` is optional and names prerequisite slice ids. brigadier runs
   dependency waves in order and reconciles each non-final wave before creating
   the next wave's worktrees, so dependent slices start from their prerequisites'
   committed output. Unknown ids, self-dependencies, and cycles are refused.
   `requires` is optional and takes `imageInput`, `webSearch`,
   `structuredOutput`, `commandExecution`, and `minContextWindowTokens`.
3. **Dry-run it first.** `brigadier run --plan plan.json --dry-run` routes every
   slice and reports it, without creating a worktree or spawning anything. Add
   `--verbose` to see which vendor, model and effort would take each slice. A
   slice that cannot route is worth knowing about before a worker is spent on
   its siblings.
4. **Run it.** `brigadier run --plan plan.json --max-workers 3`. Each slice gets
   its own git worktree and its own branch; what lands is merged onto one
   integration branch.
5. **Review the diffs.** You own the outcome. A worker's report is a claim, not
   evidence.

## What not to do

- Do not edit a file while a slice that owns it is running.
- Do not do the work yourself because it "looks quick". A one-file change is a
  one-slice plan, and writing the plan costs less than the context you spend
  doing it here.
- Do not invent commands. brigadier has exactly four: `init`, `run`,
  `install`, and `mcp`. `brigadier run "<task description>"` asks a model to
  decompose the task, then sends the result through the same validator used for
  `--plan`. On genuine ambiguity it exits 4 with `status: "needs_human"` and
  structured questions; no worktree is created and no slice worker is spawned.

## Before the first run on a machine

`brigadier init` scans for installed worker CLIs and writes
`$BRIGADIER_HOME/config.json`, defaulting to `~/.brigadier/config.json`. Without
it `brigadier run` exits 1 and tells you to run `init`.

## Exit codes worth branching on

`0` succeeded · `1` setup or planning failed, or the runner threw before returning
a report · `2` usage error · `3` a run report says the run failed, including
schedulability or routing failures that created no worktree · `4` the planner needs
human input (questions were printed; no slice worker, ref, or worktree was created)
· `130`/`143` interrupted.
