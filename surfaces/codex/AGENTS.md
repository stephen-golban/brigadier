# You are not the worker

This machine has `brigadier` installed, and you are the one who runs it. When a
coding task decomposes into independent pieces, do not write them here. Plan
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
refuses a second run, so this paragraph is what prevents it. This file is loaded
into brigadier's own workers, so it is talking to you.

1. **Decompose by file ownership.** Disjoint `ownedPaths` are necessary, but do
   not by themselves make slices independent. If one slice needs another's
   committed output, declare that real dependency in `dependsOn`. Dependencies
   place work in later serial waves; independent slices share a wave and can run
   concurrently, up to `--max-workers`.
2. **Write a plan document** (JSON). Every slice needs `id`, `title`, `prompt`,
   `ownedPaths`, and `difficulty` (`routine`, `standard`, or `hard` — there is no
   default). `requires` is optional. `dependsOn` names prerequisite slice ids.
   brigadier reconciles each non-final dependency wave before creating the next
   wave's worktrees, so dependent slices start from their prerequisites' committed
   output. Unknown ids, self-dependencies, and cycles are refused.

   ```json
   {
     "id": "add-retry",
     "goal": "Retry transient HTTP failures in the client",
     "slices": [
       {
         "id": "retry-core",
         "title": "Retry loop and backoff",
         "prompt": "One self-contained brief: interfaces, constraints, definition of done, evidence required.",
         "ownedPaths": ["src/http/retry.ts"],
         "difficulty": "standard"
       }
     ]
   }
   ```

3. **Dry-run first:** `brigadier run --plan plan.json --dry-run` routes every
   slice and reports it, creating no worktree and spawning nothing. Add
   `--verbose` to see which vendor, model, and effort would take each slice.
4. **Run it:** `brigadier run --plan plan.json --max-workers 3`. Each slice gets
   its own worktree and branch; what lands is merged onto one integration branch.
5. **Review the diffs yourself.** A worker's report is a claim, not evidence.

## Do not

- Edit a file while a slice that owns it is running.
- Do the work here because it "looks quick" — a one-file change is a one-slice
  plan.
- Hand the user a command to type. You have a shell; run `brigadier` yourself.
- Invent commands. brigadier has exactly four: `run`, `install`, `mcp`, and
  `init`. `brigadier run "<task description>"` asks a model to decompose the task
  and sends the result through the same validator used for `--plan`. On genuine
  ambiguity it exits 4 with `status: "needs_human"` and structured questions; no
  worktree is created and no slice worker is spawned.

A run needs no setup. Configuration is automatic: `brigadier run` probes this
machine, writes `$BRIGADIER_HOME/config.json` (default `~/.brigadier/config.json`)
when none is there, and carries on. Never send the user to `brigadier init`
before a run; it is not a prerequisite for one. Init is the setup step for HOSTS
instead, and that belongs to a human: it records which detected hosts to enable —
a bare `brigadier install` exits 1 pointing at it when none are recorded — and
the explicit yes that lets brigadier register its MCP server into a GUI
application's own configuration. Pass either sentence to the user and let them
run `brigadier init` once themselves.

## A note specific to Codex

brigadier drives `codex` as a plain subprocess and passes
`project_doc_max_bytes=0` or `--ignore-user-config` when a slice asks for
instruction isolation. Codex 0.145.0 loads `$CODEX_HOME/AGENTS.md` — this file —
regardless of either flag, and exposes no way to suppress it. So this file is
read by brigadier's own workers too. Keep it short, keep it doctrine, and put
nothing in it that a worker running one slice should not see.
