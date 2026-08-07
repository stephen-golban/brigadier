import { describe, expect, test } from "bun:test";
import type { Plan, Slice } from "../src/contracts.ts";
import {
  type PlanIssue,
  type PlanValidation,
  validatePlan,
} from "../src/plan/index.ts";

function slice(
  id: string,
  ownedPaths: readonly string[] = [`src/${id}.ts`],
  dependsOn: readonly string[] = [],
): Slice {
  return {
    id,
    title: `Slice ${id}`,
    prompt: `Implement ${id}`,
    ownedPaths,
    dependsOn,
  };
}

function plan(slices: readonly Slice[]): Plan {
  return { id: "plan-1", goal: "Validate a plan", slices };
}

function issuesOf(validation: PlanValidation): readonly PlanIssue[] {
  return validation.ok ? [] : validation.issues;
}

function thrownError(
  maxWorkers: number,
): { readonly name: string; readonly message: string } | null {
  try {
    validatePlan(plan([slice("a")]), { maxWorkers });
    return null;
  } catch (error) {
    if (error instanceof Error) {
      return { name: error.name, message: error.message };
    }
    return { name: "non-Error", message: String(error) };
  }
}

describe("plan validation success", () => {
  test("the validator does not consult paths or files on the current machine", async () => {
    const source = await Bun.file(
      new URL("../src/plan/validate.ts", import.meta.url),
    ).text();
    const importSpecifiers = [
      ...source.matchAll(/^import(?:[\s\S]*?\sfrom)?\s*["']([^"']+)["'];$/gm),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual(["../contracts.js", "./contracts.js"]);
  });

  test("normalizes paths deterministically and returns sorted dependency waves", () => {
    const input = plan([
      slice("b", ["src/b.ts", "./docs//b/"]),
      slice("a", ["./src/cafe\u0301.ts"]),
      slice("c", ["src/./c.ts"], ["b", "a"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 3 })).toEqual({
      ok: true,
      waves: [["a", "b"], ["c"]],
      normalizedPaths: new Map([
        ["b", ["src/b.ts", "docs/b"]],
        ["a", ["src/caf\u00e9.ts"]],
        ["c", ["src/c.ts"]],
      ]),
    });
  });

  test("puts each slice in exactly one earliest dependency wave", () => {
    const input = plan([
      slice("d", ["src/d.ts"], ["b", "c"]),
      slice("c", ["src/c.ts"], ["a"]),
      slice("b", ["src/b.ts"], ["a"]),
      slice("e", ["src/e.ts"]),
      slice("a", ["src/a.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 5 })).toEqual({
      ok: true,
      waves: [["a", "e"], ["b", "c"], ["d"]],
      normalizedPaths: new Map([
        ["d", ["src/d.ts"]],
        ["c", ["src/c.ts"]],
        ["b", ["src/b.ts"]],
        ["e", ["src/e.ts"]],
        ["a", ["src/a.ts"]],
      ]),
    });
  });
});

describe("plan and worker limits", () => {
  test("rejects an empty plan", () => {
    expect(validatePlan(plan([]), { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "EMPTY_PLAN",
          message: "a plan must contain at least one slice",
          sliceIds: [],
          paths: [],
        },
      ],
    });
  });

  test("rejects every maxWorkers value that is not a positive safe integer", () => {
    for (const value of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(thrownError(value)).toEqual({
        name: "RangeError",
        message: "maxWorkers must be a positive safe integer",
      });
    }
  });

  test("accepts sequential slices when every dependency wave fits maxWorkers", () => {
    const input = plan([slice("b", ["src/b.ts"], ["a"]), slice("a")]);

    expect(validatePlan(input, { maxWorkers: 1 })).toEqual({
      ok: true,
      waves: [["a"], ["b"]],
      normalizedPaths: new Map([
        ["b", ["src/b.ts"]],
        ["a", ["src/a.ts"]],
      ]),
    });
  });

  test("rejects a dependency wave wider than maxWorkers", () => {
    const input = plan([slice("b"), slice("a"), slice("c")]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "TOO_MANY_CONCURRENT_SLICES",
          message:
            'widest dependency wave ["a", "b", "c"] has width 3 but maxWorkers permits 2',
          sliceIds: ["a", "b", "c"],
          paths: [],
        },
      ],
    });
  });
});

describe("slice identity and ownership", () => {
  test("reports each duplicated slice id once in stable id order", () => {
    const input = plan([
      slice("z", ["src/z-one.ts"]),
      slice("a", ["src/a-one.ts"]),
      slice("z", ["src/z-two.ts"]),
      slice("a", ["src/a-two.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 4 })).toEqual({
      ok: false,
      issues: [
        {
          code: "DUPLICATE_SLICE_ID",
          message: 'slice id "a" appears 2 times; slice ids must be unique',
          sliceIds: ["a"],
          paths: [],
        },
        {
          code: "DUPLICATE_SLICE_ID",
          message: 'slice id "z" appears 2 times; slice ids must be unique',
          sliceIds: ["z"],
          paths: [],
        },
      ],
    });
  });

  test("rejects a slice with no owned paths", () => {
    expect(validatePlan(plan([slice("idle", [])]), { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "NO_OWNED_PATHS",
          message:
            'slice "idle" owns no paths and therefore has no isolated worker lane',
          sliceIds: ["idle"],
          paths: [],
        },
      ],
    });
  });

  test("rejects empty, absolute, drive, and parent-segment paths after normalization", () => {
    const input = plan([
      slice("bad", ["", "   ", "/src//x/", "C:/src/x.ts", "src/../x.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "INVALID_PATH",
          message:
            'slice "bad" owns invalid path "": path must not be empty or whitespace-only',
          sliceIds: ["bad"],
          paths: [""],
        },
        {
          code: "INVALID_PATH",
          message:
            'slice "bad" owns invalid path "   ": path must not be empty or whitespace-only',
          sliceIds: ["bad"],
          paths: ["   "],
        },
        {
          code: "INVALID_PATH",
          message:
            'slice "bad" owns invalid path "/src/x": absolute paths are not worktree-relative',
          sliceIds: ["bad"],
          paths: ["/src/x"],
        },
        {
          code: "INVALID_PATH",
          message:
            'slice "bad" owns invalid path "C:/src/x.ts": Windows drive paths are not worktree-relative',
          sliceIds: ["bad"],
          paths: ["C:/src/x.ts"],
        },
        {
          code: "INVALID_PATH",
          message:
            'slice "bad" owns invalid path "src/../x.ts": .. segments may escape the worktree root',
          sliceIds: ["bad"],
          paths: ["src/../x.ts"],
        },
      ],
    });
  });

  test("rejects backslashes instead of guessing whether they are separators", () => {
    expect(
      validatePlan(plan([slice("backslash", ["src/a\\b.ts"])]), {
        maxWorkers: 1,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: "INVALID_PATH",
          message:
            'slice "backslash" owns invalid path "src/a\\\\b.ts": brigadier targets POSIX paths, where a backslash is ambiguous between a separator and a literal filename character; spell the path with /',
          sliceIds: ["backslash"],
          paths: ["src/a\\b.ts"],
        },
      ],
    });
  });

  test("rejects control characters and names their code points", () => {
    expect(
      validatePlan(plan([slice("control", ["src/a\u0000b.ts"])]), {
        maxWorkers: 1,
      }),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: "INVALID_PATH",
          message:
            'slice "control" owns invalid path "src/a\\u0000b.ts": control character U+0000 is not permitted in a path',
          sliceIds: ["control"],
          paths: ["src/a\u0000b.ts"],
        },
      ],
    });
  });

  test("rejects every glob marker and explains why no filesystem guess is safe", () => {
    const input = plan([
      slice("glob", ["src/*.ts", "src/file?.ts", "src/[ab].ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "GLOB_PATH",
          message:
            'slice "glob" owns glob path "src/*.ts"; owned paths must be literal because a glob cannot be proven disjoint without accessing a filesystem that does not exist yet',
          sliceIds: ["glob"],
          paths: ["src/*.ts"],
        },
        {
          code: "GLOB_PATH",
          message:
            'slice "glob" owns glob path "src/file?.ts"; owned paths must be literal because a glob cannot be proven disjoint without accessing a filesystem that does not exist yet',
          sliceIds: ["glob"],
          paths: ["src/file?.ts"],
        },
        {
          code: "GLOB_PATH",
          message:
            'slice "glob" owns glob path "src/[ab].ts"; owned paths must be literal because a glob cannot be proven disjoint without accessing a filesystem that does not exist yet',
          sliceIds: ["glob"],
          paths: ["src/[ab].ts"],
        },
      ],
    });
  });

  test("reports both invalid and glob defects on one path", () => {
    expect(
      validatePlan(plan([slice("both", ["/src/*.ts"])]), { maxWorkers: 1 }),
    ).toEqual({
      ok: false,
      issues: [
        {
          code: "INVALID_PATH",
          message:
            'slice "both" owns invalid path "/src/*.ts": absolute paths are not worktree-relative',
          sliceIds: ["both"],
          paths: ["/src/*.ts"],
        },
        {
          code: "GLOB_PATH",
          message:
            'slice "both" owns glob path "/src/*.ts"; owned paths must be literal because a glob cannot be proven disjoint without accessing a filesystem that does not exist yet',
          sliceIds: ["both"],
          paths: ["/src/*.ts"],
        },
      ],
    });
  });
});

describe("path conflicts", () => {
  test("normalizes canonically equivalent Unicode paths to NFC", () => {
    const input = plan([
      slice("nfc", ["src/caf\u00e9.ts"]),
      slice("nfd", ["src/cafe\u0301.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "nfc" and "nfd" have conflicting ownership claims "src/caf\u00e9.ts"; both slices claim the exact same path',
          sliceIds: ["nfc", "nfd"],
          paths: ["src/caf\u00e9.ts"],
        },
      ],
    });
  });

  test("uses full case folding for Greek final and capital sigma", () => {
    const input = plan([
      slice("final", ["src/\u03c2.ts"]),
      slice("capital", ["src/\u03a3.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "capital" and "final" have conflicting ownership claims "src/\u03a3.ts" and "src/\u03c2.ts"; the paths differ only by case and are not portable across case-sensitive and case-insensitive filesystems',
          sliceIds: ["capital", "final"],
          paths: ["src/\u03a3.ts", "src/\u03c2.ts"],
        },
      ],
    });
  });

  test("rejects exact and ancestor claims across slices", () => {
    const exact = plan([
      slice("b", ["src/shared.ts"]),
      slice("a", ["./src//shared.ts/"]),
    ]);
    const ancestor = plan([
      slice("parent", ["src/config"]),
      slice("child", ["src/config/store.ts"]),
    ]);

    expect(validatePlan(exact, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "a" and "b" have conflicting ownership claims "src/shared.ts"; both slices claim the exact same path',
          sliceIds: ["a", "b"],
          paths: ["src/shared.ts"],
        },
      ],
    });
    expect(validatePlan(ancestor, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "child" and "parent" have conflicting ownership claims "src/config" and "src/config/store.ts"; one path is a directory ancestor of the other',
          sliceIds: ["child", "parent"],
          paths: ["src/config", "src/config/store.ts"],
        },
      ],
    });
  });

  test("src/con is not treated as an ancestor of src/config", () => {
    const input = plan([
      slice("short", ["src/con"]),
      slice("long", ["src/config"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: true,
      waves: [["long", "short"]],
      normalizedPaths: new Map([
        ["short", ["src/con"]],
        ["long", ["src/config"]],
      ]),
    });
  });

  test("a case-only path difference is a portable-filesystem conflict", () => {
    const input = plan([
      slice("upper", ["src/A.ts"]),
      slice("lower", ["src/a.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "lower" and "upper" have conflicting ownership claims "src/A.ts" and "src/a.ts"; the paths differ only by case and are not portable across case-sensitive and case-insensitive filesystems',
          sliceIds: ["lower", "upper"],
          paths: ["src/A.ts", "src/a.ts"],
        },
      ],
    });
  });

  test("case-insensitive ancestor claims conflict too", () => {
    const input = plan([
      slice("parent", ["src/Config"]),
      slice("child", ["src/config/store.ts"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slices "child" and "parent" have conflicting ownership claims "src/Config" and "src/config/store.ts"; one path is a case-insensitive directory ancestor of the other and is not portable across filesystems',
          sliceIds: ["child", "parent"],
          paths: ["src/Config", "src/config/store.ts"],
        },
      ],
    });
  });

  test("distinguishes redundant claims within one slice", () => {
    const input = plan([
      slice("one", [
        "src/x",
        "src/x/y.ts",
        "src/repeated.ts",
        "./src/repeated.ts",
      ]),
    ]);

    expect(validatePlan(input, { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "PATH_CONFLICT",
          message:
            'slice "one" has redundant ownership claims "src/x" and "src/x/y.ts"; one path is a directory ancestor of the other within one slice',
          sliceIds: ["one"],
          paths: ["src/x", "src/x/y.ts"],
        },
        {
          code: "PATH_CONFLICT",
          message:
            'slice "one" has redundant ownership claims "src/repeated.ts"; the same path is listed more than once within one slice',
          sliceIds: ["one"],
          paths: ["src/repeated.ts"],
        },
      ],
    });
  });

  test("keeps checking cross-slice conflicts after finding within-slice redundancy", () => {
    const input = plan([
      slice("a", ["src/x", "src/x/y.ts"]),
      slice("b", ["src/x/z.ts"]),
    ]);

    expect(
      issuesOf(validatePlan(input, { maxWorkers: 2 })).map(
        (issue) => issue.code,
      ),
    ).toEqual(["PATH_CONFLICT", "PATH_CONFLICT"]);
    expect(
      issuesOf(validatePlan(input, { maxWorkers: 2 })).map(
        (issue) => issue.sliceIds,
      ),
    ).toEqual([["a"], ["a", "b"]]);
  });
});

describe("dependency graph", () => {
  test("reports unknown and self dependencies", () => {
    const input = plan([
      slice("a", ["src/a.ts"], ["missing"]),
      slice("b", ["src/b.ts"], ["b"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 2 })).toEqual({
      ok: false,
      issues: [
        {
          code: "UNKNOWN_DEPENDENCY",
          message: 'slice "a" depends on unknown slice "missing"',
          sliceIds: ["a"],
          paths: [],
        },
        {
          code: "SELF_DEPENDENCY",
          message: 'slice "b" cannot depend on itself',
          sliceIds: ["b"],
          paths: [],
        },
        {
          code: "DEPENDENCY_CYCLE",
          message: 'dependency cycle contains slices: "b"',
          sliceIds: ["b"],
          paths: [],
        },
      ],
    });
  });

  test("a cycle is reported without a meaningless concurrency issue", () => {
    const input = plan([
      slice("downstream", ["src/downstream.ts"], ["b"]),
      slice("b", ["src/b.ts"], ["a"]),
      slice("a", ["src/a.ts"], ["b"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 1 })).toEqual({
      ok: false,
      issues: [
        {
          code: "DEPENDENCY_CYCLE",
          message: 'dependency cycle contains slices: "a", "b"',
          sliceIds: ["a", "b"],
          paths: [],
        },
      ],
    });
  });

  test("reports separate cycles in stable member order", () => {
    const input = plan([
      slice("z", ["src/z.ts"], ["y"]),
      slice("b", ["src/b.ts"], ["a"]),
      slice("y", ["src/y.ts"], ["z"]),
      slice("a", ["src/a.ts"], ["b"]),
    ]);

    expect(validatePlan(input, { maxWorkers: 4 })).toEqual({
      ok: false,
      issues: [
        {
          code: "DEPENDENCY_CYCLE",
          message: 'dependency cycle contains slices: "a", "b"',
          sliceIds: ["a", "b"],
          paths: [],
        },
        {
          code: "DEPENDENCY_CYCLE",
          message: 'dependency cycle contains slices: "y", "z"',
          sliceIds: ["y", "z"],
          paths: [],
        },
      ],
    });
  });
});

describe("issue collection", () => {
  test("collects all issues rather than returning after the first", () => {
    const input = plan([
      slice("same", [], ["missing"]),
      slice("same", ["/bad"]),
    ]);

    expect(
      issuesOf(validatePlan(input, { maxWorkers: 1 })).map(
        (issue) => issue.code,
      ),
    ).toEqual([
      "DUPLICATE_SLICE_ID",
      "NO_OWNED_PATHS",
      "INVALID_PATH",
      "UNKNOWN_DEPENDENCY",
    ]);
  });

  test("orders path conflicts before dependency defects", () => {
    const input = plan([
      slice("a", ["src/shared"], ["missing"]),
      slice("b", ["src/shared"]),
    ]);

    expect(
      issuesOf(validatePlan(input, { maxWorkers: 2 })).map(
        (issue) => issue.code,
      ),
    ).toEqual(["PATH_CONFLICT", "UNKNOWN_DEPENDENCY"]);
  });
});
