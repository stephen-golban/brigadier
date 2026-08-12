# The plan document

A plan decides what gets spawned, where it may write, and how capable the model
running it has to be. Whether it came from a file or the planner, it arrives at
the parser as bytes with no schema behind it and is checked twice before the
supervisor creates a ref or worktree:

1. **Shape**, by the parser that reads every plan — whether you wrote the file
   or `brigadier run "<task>"` had a model write it. Wrong types, missing
   required fields, and unknown keys are refused here.
2. **Schedulability**, by the plan validator the supervisor runs as the first
   step of every run, before it prepares a session, creates a worktree, or
   writes a ref. Duplicate ids, overlapping ownership, glob paths, unknown or
   cyclic dependencies are refused here.

Both collect **every** issue and report them together, so a plan is repaired in
one pass rather than one defect per invocation.

A plan rejected by either check costs zero worktrees, zero refs, and zero slice
workers. With a task description, the planner has already run before its plan
reaches these checks.

## Shape

```json
{
  "id": "csv-export",
  "goal": "Add CSV export to the report command",
  "verify": {
    "command": ["bun", "test"]
  },
  "slices": [
    {
      "id": "writer",
      "title": "CSV writer",
      "prompt": "Add a CSV writer in src/csv.ts that quotes fields containing commas or quotes. Export writeCsv(rows: string[][]): string. Do not change the report command itself.",
      "ownedPaths": ["src/csv.ts"],
      "dependsOn": [],
      "difficulty": "standard",
      "requires": {
        "minContextWindowTokens": 200000
      }
    }
  ]
}
```

### Plan fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | non-empty. Names every branch the run creates unless `--slug` overrides it |
| `goal` | string | yes | non-empty. One sentence |
| `slices` | array | yes | non-empty |
| `verify` | object | no | one repository-wide deterministic verification command; see below |

No top-level key other than `id`, `goal`, `slices`, or `verify` is permitted.

### `verify`

`verify.command` is a non-empty argv array whose first element is the executable
and whose remaining elements are its arguments. Array form is the only accepted
form: `["bun", "test"]` is valid, while the shell string `"bun test"` is not.
Brigadier passes the array directly to the process runner without a shell,
interpolation, or splitting. The executable must be a non-empty,
non-whitespace string. Arguments may be any string, including an empty string.
No element may contain a NUL byte; those shapes cannot be passed to the process
runner. Argument whitespace is otherwise preserved exactly.

The command belongs to the whole plan, not to an individual slice, and brigadier
does not auto-detect or invent it. Each slice attempt that reaches review runs
the same command in its worktree as the `tests_pass` deterministic gate, before
the cross-vendor model review. A failing project test therefore rejects the
slice without spending a reviewer. When `verify` is absent, `tests_pass` is
reported as skipped rather than passed.

### Slice fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `id` | string | yes | non-empty, unique across the plan |
| `title` | string | yes | non-empty, short |
| `prompt` | string | yes | non-empty. The worker's only task-specific brief |
| `ownedPaths` | string[] | yes | non-empty. Exclusive ownership; see below |
| `difficulty` | enum | yes | `routine`, `standard`, or `hard`. **No default** |
| `dependsOn` | string[] | no | defaults to `[]` |
| `requires` | object | no | capability requirements; see below |

No other key is permitted on a slice.

`difficulty` has no default on purpose. It sets the competence floor a model must
clear to be allowed to run the slice, so a default would pick one silently:
defaulting low routes real work to the cheapest model on the machine and reports
success, defaulting high burns the strongest model on a rename. A plan that does
not say how hard a slice is has not been planned.

### `requires`

Every field is optional. A requirement removes models from consideration; it
never ranks them. A model with no recorded capability data passes only when the
slice asks for none of these.

| Field | Type | Meaning |
| --- | --- | --- |
| `imageInput` | boolean | when `true`, the worker must accept image input |
| `webSearch` | boolean | when `true`, the worker must be able to search the web |
| `structuredOutput` | boolean | when `true`, the worker must support structured output |
| `commandExecution` | boolean | when `true`, the worker must be able to execute commands |
| `minContextWindowTokens` | integer | non-negative; minimum context window |

## Owned paths

A slice owns its paths **exclusively**. That ownership is what makes concurrency
safe, and it is enforced rather than advised: the worker's write lane is built
from exactly this list, in the vendor's own permission grammar.

Paths are repository-relative POSIX paths. A path may name a file or a
directory, and a worker may change anything under a directory it owns.

Before comparison, each path is normalized: Unicode NFC, repeated slashes
collapsed, `.` segments dropped, trailing slash removed. Normalization is
host-independent, because plans are validated before any worktree exists and
isolation must not depend on which machine checked first.

### Rejected outright

| Rejected | Why |
| --- | --- |
| empty or whitespace-only | not a path |
| absolute (`/etc/hosts`) | not worktree-relative |
| Windows drive (`C:/x`) | not worktree-relative |
| containing `\` | brigadier targets POSIX paths, where a backslash is ambiguous |
| containing `(`, `)`, `,`, `"`, `'` | owned paths are embedded in the worker's permission grammar |
| containing control characters | reported by code point |
| containing a `..` segment | may escape the worktree root |
| containing `*`, `?`, `[` | globs cannot be proven disjoint against a filesystem that does not exist yet |

### Conflicts

Two claims conflict when they are the same path, when one is a directory
ancestor of the other, or when either of those holds after case folding — the
last because a plan that is legal on a case-sensitive filesystem and illegal on a
case-insensitive one is a plan that behaves differently on two machines.

Conflicts are reported both **across** slices, where they break isolation, and
**within** one slice, where they are redundant claims worth fixing.

Case folding here is uppercase-then-lowercase. It is not full Unicode case
folding and not a filesystem collation model: compatibility-equivalent spellings
and locale-specific aliases can go undetected.

## Dependencies

`dependsOn` lists prerequisite slice ids. A dependent slice starts only after all
of its prerequisites have committed **and their output has been accumulated into
the base its worktree is created from** — so the dependency carries real content,
not just ordering.

That is also its cost. Every dependency serializes work that could otherwise run
concurrently, so prefer independent slices. Dependencies do **not** relax
exclusive ownership: two slices in a dependency relationship still may not claim
overlapping paths.

The validator computes topological **waves** at their full structural width.
`--max-workers` throttles concurrency within a wave. The supervisor waits for and
accumulates the whole non-final wave before it creates any worktree in the next,
so wave boundaries are real barriers and can delay slices that do not directly
depend on every member of the preceding wave.

If a slice fails, or a wave's accumulation conflicts, every later wave is
skipped. Slices already in flight are left to finish — they are independent of
the failure by definition, and their work is already paid for.

## Validation issue codes

Reported by `brigadier run`, and by the `brigadier_validate_plan` MCP tool.

| Code | Meaning |
| --- | --- |
| `EMPTY_PLAN` | a plan must contain at least one slice |
| `DUPLICATE_SLICE_ID` | slice ids must be unique |
| `NO_OWNED_PATHS` | a slice with no owned paths has no isolated worker lane |
| `INVALID_PATH` | see the rejection table above; the message names every reason |
| `GLOB_PATH` | owned paths must be literal |
| `PATH_CONFLICT` | two claims overlap, within one slice or across two |
| `UNKNOWN_DEPENDENCY` | `dependsOn` names a slice the plan does not contain |
| `SELF_DEPENDENCY` | a slice cannot depend on itself |
| `DEPENDENCY_CYCLE` | the message names the cycle's members |

When the graph is malformed, no waves are reported: an incomplete or cyclic
schedule is not a schedule, and inventing a concurrency width from one would be
worse than saying nothing.

## Branch naming

The run's **slug** names every ref it creates. `--slug` sets it explicitly and
must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Without it, the slug is derived from
the plan id by replacing every run of other characters with `-` and stripping
leading non-alphanumerics.

If nothing branch-safe survives that, the run refuses rather than substituting a
fallback: the slug names every ref, so two different plans sharing one would
collide on the same set of branches.

Given slug `S`, a run creates:

| Ref | Lifetime |
| --- | --- |
| `brigadier/S/base` | the immutable scratch base; retired when the run ends |
| `brigadier/S/slice-N` | one per attempt, globally numbered; retired when the run ends |
| `brigadier/S` | the integration branch — what survives, and what you merge |

Attempt numbering is `sliceIndex * 2 + attempt`, so the first slice owns numbers
1 and 2, the second owns 3 and 4, and so on. A retry never reuses its
predecessor's number, because the branch ref outlives the removed worktree and
creating a branch that already exists is a hard failure.

Worktrees live at `<repo>-brigadier/S/slice-N` — siblings of your repository,
never inside it — and are removed when the run ends, along with the two
directories above them if they are empty.

## Writing a good slice prompt

The worker receives no plan, sibling slices, or host conversation. The
supervisor prepends the write-lane boundary to the prompt, and repository project
instructions may still load. A prompt that assumes task context the worker does
not have produces a slice that fails its gate for reasons that are not the
model's fault.

Name the files, the interfaces, the constraints, and the definition of done.
State what the slice may **not** touch — the worker cannot write outside its
owned paths, and a prompt that asks it to is a prompt that cannot succeed. If a
correct implementation requires fixing something in a file this slice does not
own, that is a re-slicing signal, not a prompt to write: the reviewer will
correctly block work that misbehaves because of a dependency the slice was
forbidden to repair, and the retry will meet the same objection.

Size a slice to one fresh context — roughly fifteen to twenty files and one
deliverable. A slice that produces more than 96 KiB of diff has outgrown its
review, which is shown at most that much.
