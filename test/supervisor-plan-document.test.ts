import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AttemptSlot,
  PlanDocument,
  SliceDirective,
  SliceResult,
} from "../src/supervisor/contracts.ts";
import {
  ATTEMPT_LIMIT,
  RUN_FAILURE_REASONS,
  SLICE_FAILURE_KINDS,
} from "../src/supervisor/contracts.ts";
import {
  PlanDocumentError,
  parsePlanDocument,
} from "../src/supervisor/plan-document.ts";
import type {
  CreatedWorktree,
  WorktreeSession,
} from "../src/worktree/contracts.ts";

const SESSION: WorktreeSession = {
  repositoryPath: "/scratch/repo",
  slug: "rate-limit",
  baseCommit: "b45e0000",
  baseBranch: "main",
  integrationBranch: "brigadier/rate-limit/integration",
};

const WORKTREE: CreatedWorktree = {
  repositoryPath: "/scratch/repo",
  path: "/scratch/wt/slice-1",
  branch: "brigadier/rate-limit/slice-1",
  isolated: true,
  session: SESSION,
};

const SUCCEEDED: SliceResult = {
  sliceId: "limiter",
  ok: true,
  branch: "brigadier/rate-limit/slice-1",
  commit: "c0ffee1",
  worktree: WORKTREE,
  attempts: [],
};

const FAILED: SliceResult = {
  sliceId: "wire",
  ok: false,
  branch: null,
  commit: null,
  worktree: null,
  attempts: [],
};

/**
 * The shape `brigadier run --plan <file>` actually reads: one object per slice,
 * with `difficulty` and `requires` sitting beside the frozen `Slice` fields.
 * Splitting this into a `Plan` plus a `SliceDirective[]` is the whole job.
 *
 * The second slice omits `dependsOn` and `requires` on purpose: those are the
 * only two optional fields, and the default for one (`[]`) and the absence of
 * the other (no key at all) are both pinned below.
 */
const ON_DISK = {
  id: "add-rate-limiting",
  goal: "Add rate limiting to the public API",
  slices: [
    {
      id: "limiter",
      title: "Token bucket",
      prompt: "Implement a token bucket limiter",
      ownedPaths: ["src/limit.ts"],
      dependsOn: [],
      difficulty: "standard",
      requires: { minContextWindowTokens: 120000 },
    },
    {
      id: "wire",
      title: "Wire the limiter into the request path",
      prompt: "Call the limiter before the handler runs",
      ownedPaths: ["src/router.ts", "src/server.ts"],
      difficulty: "hard",
    },
  ],
} as const;

const PARSED: PlanDocument = {
  plan: {
    id: "add-rate-limiting",
    goal: "Add rate limiting to the public API",
    slices: [
      {
        id: "limiter",
        title: "Token bucket",
        prompt: "Implement a token bucket limiter",
        ownedPaths: ["src/limit.ts"],
        dependsOn: [],
      },
      {
        id: "wire",
        title: "Wire the limiter into the request path",
        prompt: "Call the limiter before the handler runs",
        ownedPaths: ["src/router.ts", "src/server.ts"],
        dependsOn: [],
      },
    ],
  },
  directives: [
    {
      sliceId: "limiter",
      difficulty: "standard",
      requires: { minContextWindowTokens: 120000 },
    },
    { sliceId: "wire", difficulty: "hard" },
  ],
};

/** A minimal slice with every required field, for one-defect fixtures. */
function slice(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "limiter",
    title: "Token bucket",
    prompt: "Implement a token bucket limiter",
    ownedPaths: ["src/limit.ts"],
    difficulty: "standard",
    ...overrides,
  };
}

/** A minimal document wrapping exactly the slices given. */
function document(
  slices: readonly unknown[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "add-rate-limiting",
    goal: "Add rate limiting to the public API",
    slices,
    ...overrides,
  };
}

/**
 * Parses and asserts rejection, returning the full issue list. Every caller
 * pins that list against absolute strings: "it threw" is not the claim under
 * test, "it said exactly this" is.
 */
function rejectionIssues(value: unknown): readonly string[] {
  let issues: readonly string[] | null = null;
  try {
    parsePlanDocument(value);
  } catch (error) {
    expect(error).toBeInstanceOf(PlanDocumentError);
    issues = (error as PlanDocumentError).issues;
  }
  if (issues === null) {
    throw new Error("expected parsePlanDocument to reject this document");
  }
  return issues;
}

describe("parsePlanDocument: the accepted document", () => {
  test("splits the on-disk shape into a plan and its aligned directives", () => {
    const parsed = parsePlanDocument(structuredClone(ON_DISK));
    expect(parsed).toEqual(PARSED);

    // Alignment by position is the invariant every consumer relies on, and
    // `toEqual` above would still pass if the directives came back reversed
    // while the slices did not, so it is pinned separately and by index.
    expect(parsed.directives.map((entry) => entry.sliceId)).toEqual([
      "limiter",
      "wire",
    ]);
    expect(parsed.plan.slices.map((entry) => entry.id)).toEqual([
      "limiter",
      "wire",
    ]);
    expect(parsed.directives).toHaveLength(parsed.plan.slices.length);
  });

  test("emits canonical key order at every level", () => {
    const parsed = parsePlanDocument(structuredClone(ON_DISK));
    expect(Object.keys(parsed)).toEqual(["plan", "directives"]);
    expect(Object.keys(parsed.plan)).toEqual(["id", "goal", "slices"]);
    expect(Object.keys(parsed.plan.slices[0] ?? {})).toEqual([
      "id",
      "title",
      "prompt",
      "ownedPaths",
      "dependsOn",
    ]);
    expect(Object.keys(parsed.directives[0] ?? {})).toEqual([
      "sliceId",
      "difficulty",
      "requires",
    ]);
  });

  test("omits the requires key entirely when the slice declared none", () => {
    const parsed = parsePlanDocument(structuredClone(ON_DISK));
    const second = parsed.directives[1] as SliceDirective;
    // `toEqual` treats a missing key and an `undefined` value as equal, so the
    // difference — which is the whole point of an optional side-channel field —
    // has to be asserted on the key set.
    expect(Object.keys(second)).toEqual(["sliceId", "difficulty"]);
    expect("requires" in second).toBe(false);
  });

  test("defaults an absent dependsOn to an empty array", () => {
    const parsed = parsePlanDocument(
      document([slice(), slice({ id: "wire", ownedPaths: ["src/wire.ts"] })]),
    );
    expect(parsed.plan.slices[0]?.dependsOn).toEqual([]);
    expect(parsed.plan.slices[1]?.dependsOn).toEqual([]);
  });

  test("keeps a declared dependsOn verbatim and in order", () => {
    const parsed = parsePlanDocument(
      document([
        slice(),
        slice({
          id: "wire",
          ownedPaths: ["src/wire.ts"],
          dependsOn: ["limiter", "zzz-not-checked-here"],
        }),
      ]),
    );
    expect(parsed.plan.slices[1]?.dependsOn).toEqual([
      "limiter",
      "zzz-not-checked-here",
    ]);
  });

  test("accepts every difficulty word and no other", () => {
    for (const difficulty of ["routine", "standard", "hard"] as const) {
      const parsed = parsePlanDocument(document([slice({ difficulty })]));
      expect(parsed.directives[0]?.difficulty).toBe(difficulty);
    }
    expect(
      rejectionIssues(document([slice({ difficulty: "Standard" })])),
    ).toEqual([
      'slices[0]: difficulty "Standard" is not one of routine, standard, hard',
    ]);
  });

  test("accepts a full requires block and preserves its canonical key order", () => {
    const parsed = parsePlanDocument(
      document([
        slice({
          requires: {
            minContextWindowTokens: 0,
            structuredOutput: true,
            webSearch: false,
            imageInput: true,
          },
        }),
      ]),
    );
    expect(parsed.directives[0]?.requires).toEqual({
      imageInput: true,
      webSearch: false,
      structuredOutput: true,
      minContextWindowTokens: 0,
    });
    expect(Object.keys(parsed.directives[0]?.requires ?? {})).toEqual([
      "imageInput",
      "webSearch",
      "structuredOutput",
      "minContextWindowTokens",
    ]);
  });

  test("keeps an empty requires block as a present, empty object", () => {
    const parsed = parsePlanDocument(document([slice({ requires: {} })]));
    const directive = parsed.directives[0] as SliceDirective;
    expect(Object.keys(directive)).toEqual([
      "sliceId",
      "difficulty",
      "requires",
    ]);
    expect(directive.requires).toEqual({});
  });

  test("freezes every object and array it returns", () => {
    const parsed = parsePlanDocument(structuredClone(ON_DISK));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.plan)).toBe(true);
    expect(Object.isFrozen(parsed.plan.slices)).toBe(true);
    expect(Object.isFrozen(parsed.plan.slices[0])).toBe(true);
    expect(Object.isFrozen(parsed.plan.slices[0]?.ownedPaths)).toBe(true);
    expect(Object.isFrozen(parsed.plan.slices[0]?.dependsOn)).toBe(true);
    expect(Object.isFrozen(parsed.directives)).toBe(true);
    expect(Object.isFrozen(parsed.directives[0])).toBe(true);
    expect(Object.isFrozen(parsed.directives[0]?.requires)).toBe(true);
  });

  test("copies rather than aliases the caller's arrays", () => {
    const source = structuredClone(ON_DISK) as unknown as {
      slices: { ownedPaths: string[]; dependsOn: string[] }[];
    };
    const parsed = parsePlanDocument(source);
    source.slices[0]?.ownedPaths.push("src/hijacked.ts");
    source.slices[0]?.dependsOn.push("hijacked");
    expect(parsed.plan.slices[0]?.ownedPaths).toEqual(["src/limit.ts"]);
    expect(parsed.plan.slices[0]?.dependsOn).toEqual([]);
  });

  test("reads each slice property exactly once", () => {
    // A property read twice is a property that can return two different values.
    // The parser destructures once for that reason; this pins it.
    let reads = 0;
    const hostile = {
      id: "limiter",
      get title(): string {
        reads += 1;
        return reads === 1 ? "Token bucket" : "SMUGGLED";
      },
      prompt: "Implement a token bucket limiter",
      ownedPaths: ["src/limit.ts"],
      difficulty: "standard",
    };
    const parsed = parsePlanDocument(document([hostile]));
    expect(reads).toBe(1);
    expect(parsed.plan.slices[0]?.title).toBe("Token bucket");
  });
});

describe("parsePlanDocument: document-level rejection", () => {
  test("rejects every non-object root with one issue", () => {
    const cases: readonly unknown[] = [
      "not-an-object",
      null,
      42,
      true,
      [],
      [{ id: "limiter" }],
    ];
    for (const value of cases) {
      expect(rejectionIssues(value)).toEqual(["plan must be a JSON object"]);
    }
  });

  test("rejects a missing or empty id", () => {
    expect(rejectionIssues(document([slice()], { id: undefined }))).toEqual([
      "plan id must be a non-empty string",
    ]);
    expect(rejectionIssues(document([slice()], { id: "" }))).toEqual([
      "plan id must be a non-empty string",
    ]);
    expect(rejectionIssues(document([slice()], { id: 7 }))).toEqual([
      "plan id must be a non-empty string",
    ]);
  });

  test("rejects a missing or empty goal", () => {
    expect(rejectionIssues(document([slice()], { goal: undefined }))).toEqual([
      "plan goal must be a non-empty string",
    ]);
    expect(rejectionIssues(document([slice()], { goal: "" }))).toEqual([
      "plan goal must be a non-empty string",
    ]);
  });

  test("rejects a non-array slices field and stops there", () => {
    // The per-slice rules are meaningless without a list to walk, so a bad
    // `slices` must not also produce invented complaints about slice 0.
    expect(rejectionIssues(document([], { slices: undefined }))).toEqual([
      "plan slices must be an array",
    ]);
    expect(rejectionIssues(document([], { slices: "limiter" }))).toEqual([
      "plan slices must be an array",
    ]);
    expect(
      rejectionIssues(document([], { id: "", slices: { limiter: {} } })),
    ).toEqual([
      "plan id must be a non-empty string",
      "plan slices must be an array",
    ]);
  });

  test("rejects an empty slices array", () => {
    expect(rejectionIssues(document([]))).toEqual([
      "plan slices must not be empty",
    ]);
  });

  test("rejects unknown document keys", () => {
    expect(rejectionIssues(document([slice()], { maxWorkers: 4 }))).toEqual([
      'plan: unknown key "maxWorkers"',
    ]);
    expect(
      rejectionIssues(
        document([slice()], { maxWorkers: 4, apiKey: "sk-live-secret" }),
      ),
    ).toEqual(['plan: unknown key "maxWorkers"', 'plan: unknown key "apiKey"']);
  });
});

describe("parsePlanDocument: slice-level rejection", () => {
  test("rejects a non-object slice", () => {
    expect(rejectionIssues(document(["limiter"]))).toEqual([
      "slices[0] must be an object",
    ]);
    expect(rejectionIssues(document([slice(), null]))).toEqual([
      "slices[1] must be an object",
    ]);
  });

  test("rejects unknown slice keys", () => {
    expect(
      rejectionIssues(document([slice({ model: "claude-opus-4-6" })])),
    ).toEqual(['slices[0]: unknown key "model"']);
    expect(
      rejectionIssues(
        document([slice(), slice({ id: "wire", vendor: "codex" })]),
      ),
    ).toEqual(['slices[1]: unknown key "vendor"']);
  });

  test("rejects a missing or empty id, title, or prompt", () => {
    expect(
      rejectionIssues(
        document([slice({ id: undefined, title: "", prompt: 3 })]),
      ),
    ).toEqual([
      "slices[0].id must be a non-empty string",
      "slices[0].title must be a non-empty string",
      "slices[0].prompt must be a non-empty string",
    ]);
  });

  test("rejects ownedPaths that is absent, not an array, or empty", () => {
    expect(
      rejectionIssues(document([slice({ ownedPaths: undefined })])),
    ).toEqual(["slices[0].ownedPaths must be an array"]);
    expect(
      rejectionIssues(document([slice({ ownedPaths: "src/limit.ts" })])),
    ).toEqual(["slices[0].ownedPaths must be an array"]);
    expect(rejectionIssues(document([slice({ ownedPaths: [] })]))).toEqual([
      "slices[0].ownedPaths must not be empty",
    ]);
  });

  test("rejects each non-string or empty owned path by index", () => {
    expect(
      rejectionIssues(
        document([slice({ ownedPaths: ["src/limit.ts", "", 5, null] })]),
      ),
    ).toEqual([
      "slices[0].ownedPaths[1] must be a non-empty string",
      "slices[0].ownedPaths[2] must be a non-empty string",
      "slices[0].ownedPaths[3] must be a non-empty string",
    ]);
  });

  test("rejects a dependsOn that is present but not an array of strings", () => {
    expect(
      rejectionIssues(document([slice({ dependsOn: "limiter" })])),
    ).toEqual(["slices[0].dependsOn must be an array"]);
    expect(
      rejectionIssues(document([slice({ dependsOn: [1, "ok", null] })])),
    ).toEqual([
      "slices[0].dependsOn[0] must be a string",
      "slices[0].dependsOn[2] must be a string",
    ]);
  });

  test("rejects an absent difficulty rather than defaulting it", () => {
    // The ruling this pins: a plan that does not say how hard a slice is has
    // not been planned. Defaulting would route real work at a guessed floor and
    // report success, which is the one failure mode with no visible symptom.
    expect(
      rejectionIssues(document([slice({ difficulty: undefined })])),
    ).toEqual([
      "slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
    ]);
    const bare = { ...slice() };
    delete bare.difficulty;
    expect(rejectionIssues(document([bare]))).toEqual([
      "slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
    ]);
  });

  test("rejects a difficulty outside the three words", () => {
    expect(
      rejectionIssues(document([slice({ difficulty: "trivial" })])),
    ).toEqual([
      'slices[0]: difficulty "trivial" is not one of routine, standard, hard',
    ]);
    expect(rejectionIssues(document([slice({ difficulty: 3 })]))).toEqual([
      "slices[0]: difficulty 3 is not one of routine, standard, hard",
    ]);
    expect(rejectionIssues(document([slice({ difficulty: null })]))).toEqual([
      "slices[0]: difficulty null is not one of routine, standard, hard",
    ]);
  });
});

describe("parsePlanDocument: requires rejection", () => {
  test("rejects a non-object requires", () => {
    expect(rejectionIssues(document([slice({ requires: null })]))).toEqual([
      "slices[0].requires must be an object",
    ]);
    expect(rejectionIssues(document([slice({ requires: [] })]))).toEqual([
      "slices[0].requires must be an object",
    ]);
    expect(rejectionIssues(document([slice({ requires: true })]))).toEqual([
      "slices[0].requires must be an object",
    ]);
  });

  test("rejects unknown requires keys", () => {
    expect(
      rejectionIssues(
        document([slice({ requires: { gpu: true, minContextWindow: 1 } })]),
      ),
    ).toEqual([
      'slices[0].requires: unknown key "gpu"',
      'slices[0].requires: unknown key "minContextWindow"',
    ]);
  });

  test("rejects non-boolean capability flags, naming each one", () => {
    expect(
      rejectionIssues(
        document([
          slice({
            requires: {
              imageInput: "yes",
              webSearch: 1,
              structuredOutput: null,
            },
          }),
        ]),
      ),
    ).toEqual([
      "slices[0].requires.imageInput must be a boolean",
      "slices[0].requires.webSearch must be a boolean",
      "slices[0].requires.structuredOutput must be a boolean",
    ]);
  });

  test("rejects a minContextWindowTokens that is not a non-negative safe integer", () => {
    const bad: readonly unknown[] = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      "120000",
      null,
    ];
    for (const value of bad) {
      expect(
        rejectionIssues(
          document([slice({ requires: { minContextWindowTokens: value } })]),
        ),
      ).toEqual([
        "slices[0].requires.minContextWindowTokens must be a non-negative safe integer",
      ]);
    }
  });

  test("accepts zero and the largest safe integer", () => {
    for (const value of [0, Number.MAX_SAFE_INTEGER]) {
      const parsed = parsePlanDocument(
        document([slice({ requires: { minContextWindowTokens: value } })]),
      );
      expect(parsed.directives[0]?.requires?.minContextWindowTokens).toBe(
        value,
      );
    }
  });
});

describe("parsePlanDocument: collecting every issue", () => {
  test("reports every defect in one throw, in document order", () => {
    const broken = {
      id: "",
      goal: "",
      maxWorkers: 4,
      slices: [
        {
          id: "limiter",
          title: "Token bucket",
          prompt: "Implement a token bucket limiter",
          ownedPaths: [],
          dependsOn: "limiter",
          model: "claude-opus-4-6",
        },
        "not-a-slice",
        {
          id: "wire",
          title: "Wire it up",
          prompt: "Call the limiter",
          ownedPaths: ["src/wire.ts"],
          difficulty: "trivial",
          requires: { imageInput: "yes", gpu: true },
        },
      ],
    };
    expect(rejectionIssues(broken)).toEqual([
      'plan: unknown key "maxWorkers"',
      "plan id must be a non-empty string",
      "plan goal must be a non-empty string",
      'slices[0]: unknown key "model"',
      "slices[0].ownedPaths must not be empty",
      "slices[0].dependsOn must be an array",
      "slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
      "slices[1] must be an object",
      'slices[2]: difficulty "trivial" is not one of routine, standard, hard',
      'slices[2].requires: unknown key "gpu"',
      "slices[2].requires.imageInput must be a boolean",
    ]);
  });

  test("throws exactly once, with the joined message", () => {
    let thrown = 0;
    try {
      parsePlanDocument({ id: "", goal: "", slices: [] });
    } catch (error) {
      thrown += 1;
      expect(error).toBeInstanceOf(PlanDocumentError);
      expect(error).toBeInstanceOf(Error);
      const failure = error as PlanDocumentError;
      expect(failure.name).toBe("PlanDocumentError");
      expect(failure.issues).toEqual([
        "plan id must be a non-empty string",
        "plan goal must be a non-empty string",
        "plan slices must not be empty",
      ]);
      expect(failure.message).toBe(
        "invalid plan document: plan id must be a non-empty string; plan goal must be a non-empty string; plan slices must not be empty",
      );
    }
    expect(thrown).toBe(1);
  });

  test("copies the issue list it was constructed with", () => {
    const issues = ["first"];
    const error = new PlanDocumentError(issues);
    issues.push("smuggled");
    expect(error.issues).toEqual(["first"]);
  });

  /**
   * The bound, asserted rather than assumed. Every loop in the parser walks an
   * array whose length is fixed before the loop starts, so a document with N
   * identically-broken slices produces exactly N issues and terminates. A parser
   * that rescanned, retried, or advanced by a value derived from its own input
   * would either hang here or blow the count, and a test that only checked
   * "it threw" would notice neither.
   */
  test("produces exactly one issue per broken slice and terminates", () => {
    const slices = Array.from({ length: 200 }, (_, index) =>
      slice({
        id: `slice-${index}`,
        ownedPaths: [`src/slice-${index}.ts`],
        difficulty: undefined,
      }),
    );
    const issues = rejectionIssues(document(slices));
    expect(issues).toHaveLength(200);
    expect(issues[0]).toBe(
      "slices[0].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
    );
    expect(issues[199]).toBe(
      "slices[199].difficulty is required and must be one of routine, standard, hard — a plan that does not say how hard a slice is has not been planned",
    );
    expect(new Set(issues).size).toBe(200);
  });
});

describe("supervisor contracts", () => {
  test("names every slice failure kind and run failure reason", () => {
    expect(SLICE_FAILURE_KINDS).toEqual([
      "ROUTING_FAILED",
      "WORKTREE_FAILED",
      "WORKER_FAILED",
      "NO_CHANGES",
      "COMMIT_FAILED",
    ]);
    expect(RUN_FAILURE_REASONS).toEqual([
      "PLAN_INVALID",
      "PREFLIGHT_ROUTING_FAILED",
      "PREPARE_FAILED",
      "SLICE_FAILED",
      "MERGE_CONFLICT",
    ]);
    expect(new Set(SLICE_FAILURE_KINDS).size).toBe(5);
    expect(new Set(RUN_FAILURE_REASONS).size).toBe(5);
  });

  test("caps a slice at two attempts, each with its own worktree identity", () => {
    expect(ATTEMPT_LIMIT).toBe(2);
    // A retry cannot reuse its predecessor's slice number: `engine.remove()`
    // leaves the slice branch ref behind and `engine.create()` refuses to
    // overwrite an existing branch. Distinctness is the property that matters.
    const slots: readonly AttemptSlot[] = [
      { sliceNumber: 1, worktreePath: "/scratch/brigadier/slice-1" },
      { sliceNumber: 2, worktreePath: "/scratch/brigadier/slice-2" },
    ];
    expect(slots).toHaveLength(ATTEMPT_LIMIT);
    expect(new Set(slots.map((slot) => slot.sliceNumber)).size).toBe(2);
    expect(new Set(slots.map((slot) => slot.worktreePath)).size).toBe(2);
  });

  test("a failed slice result carries no worktree to merge", () => {
    const failed: SliceResult = {
      sliceId: "limiter",
      ok: false,
      branch: null,
      commit: null,
      worktree: null,
      attempts: [],
    };
    expect(failed.worktree).toBeNull();
    expect(Object.keys(failed)).toEqual([
      "sliceId",
      "ok",
      "branch",
      "commit",
      "worktree",
      "attempts",
    ]);
  });

  /**
   * The acceptance criterion for the discriminated union, and it is a COMPILE
   * TIME test: the assignments below are to explicitly non-nullable locals, with
   * no `!`, no `as`, and no assertion of any kind. If `SliceResult` were flat
   * again — `ok: boolean` beside `worktree: CreatedWorktree | null` — narrowing
   * on `result.ok` would yield nullable fields and `bun run typecheck` would
   * fail here. The runtime assertions only confirm the loop ran.
   */
  test("narrowing on ok yields a non-null worktree and commit with no assertion", () => {
    const results: readonly SliceResult[] = [SUCCEEDED, FAILED];
    const merged: string[] = [];
    const abandoned: string[] = [];

    for (const result of results) {
      if (!result.ok) {
        // The other side of the narrowing: these are `null`, not "possibly null".
        const noWorktree: null = result.worktree;
        const noCommit: null = result.commit;
        expect(noWorktree).toBeNull();
        expect(noCommit).toBeNull();
        abandoned.push(result.sliceId);
        continue;
      }
      const worktree: CreatedWorktree = result.worktree;
      const commit: string = result.commit;
      const branch: string = result.branch;
      merged.push(`${result.sliceId}:${branch}@${commit}:${worktree.path}`);
    }

    expect(merged).toEqual([
      "limiter:brigadier/rate-limit/slice-1@c0ffee1:/scratch/wt/slice-1",
    ]);
    expect(abandoned).toEqual(["wire"]);
  });

  /**
   * The illegal states, proven unrepresentable. Each `@ts-expect-error` is
   * itself the assertion: if the union were loosened so one of these literals
   * became legal, the directive would have nothing to suppress and `tsc` would
   * fail with "Unused '@ts-expect-error' directive". This is the only way to
   * test that something does NOT compile.
   */
  test("cannot express a successful slice with nothing to merge", () => {
    // Each literal below differs from a legal one in exactly ONE field, so the
    // single error the directive suppresses can only be the intended one.
    // @ts-expect-error a successful slice always holds the worktree to merge
    const successWithoutWorktree: SliceResult = {
      ...SUCCEEDED,
      worktree: null,
    };
    // @ts-expect-error a successful slice always names the commit it produced
    const successWithoutCommit: SliceResult = { ...SUCCEEDED, commit: null };
    // @ts-expect-error a successful slice always names the branch it landed on
    const successWithoutBranch: SliceResult = { ...SUCCEEDED, branch: null };
    // @ts-expect-error a failed slice never carries a commit
    const failureWithCommit: SliceResult = { ...FAILED, commit: "c0ffee2" };
    // @ts-expect-error the runner already removed every failed attempt's worktree
    const failureWithWorktree: SliceResult = { ...FAILED, worktree: WORKTREE };

    expect(successWithoutWorktree.ok).toBe(true);
    expect(successWithoutCommit.ok).toBe(true);
    expect(successWithoutBranch.ok).toBe(true);
    expect(failureWithCommit.ok).toBe(false);
    expect(failureWithWorktree.ok).toBe(false);
  });
});

describe("supervisor sources", () => {
  /**
   * Control characters in a source file survive review — they are invisible —
   * and reach a worker prompt or a git message intact. The class is assembled
   * from code points so this guard does not contain the bytes it forbids.
   */
  test("contain no control characters", async () => {
    const forbidden = new Set<number>([
      ...Array.from({ length: 9 }, (_, index) => index), // U+0000..U+0008
      0x0b,
      0x0c,
      ...Array.from({ length: 18 }, (_, index) => index + 0x0e), // U+000E..U+001F
      0x7f,
    ]);
    const projectRoot = resolve(import.meta.dir, "..");
    const supervisorRoot = resolve(projectRoot, "src/supervisor");
    const pendingDirectories = [supervisorRoot];
    const files = [fileURLToPath(import.meta.url)];
    while (pendingDirectories.length > 0) {
      const directory = pendingDirectories.pop();
      if (directory === undefined) {
        break;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
          pendingDirectories.push(path);
        } else if (entry.isFile()) {
          files.push(path);
        }
      }
    }

    const offending: { readonly file: string; readonly codePoint: string }[] =
      [];
    for (const file of files.sort()) {
      const source = await readFile(file, "utf8");
      for (const character of source) {
        const codePoint = character.codePointAt(0) ?? 0;
        if (forbidden.has(codePoint)) {
          offending.push({
            file: relative(projectRoot, file),
            codePoint: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
          });
        }
      }
    }
    expect(offending).toEqual([]);
  });
});
