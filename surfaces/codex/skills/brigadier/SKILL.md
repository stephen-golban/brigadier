---
name: brigadier
description: Load before starting any coding task with more than one independent piece of work — a feature, a cross-file refactor, a migration, a bug with several call sites, a batch of mechanical edits. Routes the work to the brigadier CLI instead of doing it in this session.
---

# You are not the worker

This machine has `brigadier` installed, and you are the one who runs it. When a
task decomposes into independent pieces, you do not write them here. You plan
them, invoke `brigadier run` yourself from inside this session, and review what
comes back. Your context is for coordination and judgement; a worker session is
disposable and starts clean.

## If you are already a brigadier worker, stop here

**A brigadier worker must never invoke brigadier.** If the prompt you were given
is one slice of somebody else's plan — it names an `id`, the paths you own, and
the evidence you owe — then you are the worker, and the work in front of you is
the work you do. Spawning a second orchestrator from inside a slice spends the
whole slice and lands nothing. This has happened. brigadier stamps
`BRIGADIER_WORKER=1` into every worker's environment, which is enough to keep the
nudge hook quiet inside a worker but does not stop you: nothing in the product
refuses a second run, so this paragraph is what prevents it.

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
- Do not hand the user a command to type. You have a shell; run `brigadier`
  yourself and report what it did.
- Do not invent commands. brigadier has exactly four: `run`, `install`, `mcp`,
  and `init`. `brigadier run "<task description>"` asks a model to decompose the
  task, then sends the result through the same validator used for `--plan`. On
  genuine ambiguity it exits 4 with `status: "needs_human"` and structured
  questions; no worktree is created and no slice worker is spawned.

## A run needs no setup

Configuration is automatic. `brigadier run` probes this machine for installed
worker CLIs, writes `$BRIGADIER_HOME/config.json` — `~/.brigadier/config.json` by
default — when none is there, and carries on. Never send the user to
`brigadier init` before a run: it has never been a prerequisite for one, and a
turn spent on it is a turn wasted. Init is the setup step for HOSTS, not for
runs, and that part is not yours to take: it asks which detected hosts to enable
and records them, so a bare `brigadier install` exits 1 pointing at it when none
are recorded, and registering brigadier's MCP server into a GUI application's own
configuration takes a human's explicit yes that only its interactive question can
ask for. Pass either sentence to the user and let them run it once themselves.

## Exit codes worth branching on

`0` succeeded · `1` setup or planning failed, or the runner threw before returning
a report · `2` usage error · `3` a run report says the run failed, including
schedulability or routing failures that created no worktree · `4` the planner needs
human input (questions were printed; no slice worker, ref, or worktree was created)
· `130`/`143` interrupted.
