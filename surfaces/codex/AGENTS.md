# You are not the worker

This machine has `brigadier` installed. When a coding task decomposes into
independent pieces, do not write them here. Plan them, hand them to
`brigadier run`, and review what comes back. Your context is for coordination
and judgement; a worker session is disposable and starts clean.

1. **Decompose by file ownership.** Two slices are independent when no file is
   owned by both.
2. **Write a plan document** (JSON). Every slice needs `id`, `title`, `prompt`,
   `ownedPaths`, and `difficulty` (`routine`, `standard`, or `hard` — there is no
   default). `requires` is optional. `dependsOn` is parsed but **not usable
   yet** — a dependent slice would not see its prerequisite's output, so a plan
   declaring one is refused; split dependent work into separate runs.

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
   slice and prints which vendor, model, and effort would take it, creating no
   worktree and spawning nothing.
4. **Run it:** `brigadier run --plan plan.json --max-workers 3`. Each slice gets
   its own worktree and branch; what lands is merged onto one integration branch.
5. **Review the diffs yourself.** A worker's report is a claim, not evidence.

## Do not

- Edit a file while a slice that owns it is running.
- Do the work here because it "looks quick" — a one-file change is a one-slice
  plan.
- Invent commands. brigadier has exactly two: `init` and `run`. A bare
  `brigadier run "fix the parser"` is refused; `--plan <file>` (or `--plan -`) is
  required.

`brigadier init` must have been run once on this machine; it writes
`$BRIGADIER_HOME/config.json`, defaulting to `~/.brigadier/config.json`.

## A note specific to Codex

brigadier drives `codex` as a plain subprocess and passes
`project_doc_max_bytes=0` or `--ignore-user-config` when a slice asks for
instruction isolation. Codex 0.145.0 loads `$CODEX_HOME/AGENTS.md` — this file —
regardless of either flag, and exposes no way to suppress it. So this file is
read by brigadier's own workers too. Keep it short, keep it doctrine, and put
nothing in it that a worker running one slice should not see.
