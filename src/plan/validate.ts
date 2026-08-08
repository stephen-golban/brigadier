import type { Plan } from "../contracts.js";
import type { PlanIssue, PlanValidation } from "./contracts.js";

interface PathClaim {
  readonly path: string;
  readonly sliceId: string;
}

type ConflictReason = "exact" | "ancestor" | "case" | "case-ancestor";

interface Conflict {
  readonly reason: ConflictReason;
  readonly paths: readonly string[];
}

/**
 * Validates a proposed plan without consulting the current checkout. Plans are
 * produced before their worker trees exist, so filesystem-dependent guesses
 * here would make isolation depend on whichever machine validates first.
 */
export function validatePlan(plan: Plan): PlanValidation {
  const emptyIssues: PlanIssue[] = [];
  const duplicateIdIssues: PlanIssue[] = [];
  const noOwnedPathIssues: PlanIssue[] = [];
  const invalidPathIssues: PlanIssue[] = [];
  const globPathIssues: PlanIssue[] = [];
  const conflictIssues: PlanIssue[] = [];
  const unknownDependencyIssues: PlanIssue[] = [];
  const selfDependencyIssues: PlanIssue[] = [];
  const cycleIssues: PlanIssue[] = [];
  const unsupportedDependencyIssues: PlanIssue[] = [];

  if (plan.slices.length === 0) {
    emptyIssues.push({
      code: "EMPTY_PLAN",
      message: "a plan must contain at least one slice",
      sliceIds: [],
      paths: [],
    });
  }

  const slicesById = new Map<string, number[]>();
  for (const [index, slice] of plan.slices.entries()) {
    const indices = slicesById.get(slice.id);
    if (indices === undefined) {
      slicesById.set(slice.id, [index]);
    } else {
      indices.push(index);
    }
  }
  for (const id of [...slicesById.keys()].sort()) {
    const indices = slicesById.get(id);
    if (indices !== undefined && indices.length > 1) {
      duplicateIdIssues.push({
        code: "DUPLICATE_SLICE_ID",
        message: `slice id ${JSON.stringify(id)} appears ${indices.length} times; slice ids must be unique`,
        sliceIds: [id],
        paths: [],
      });
    }
  }

  const normalizedPathsByIndex: string[][] = [];
  const usableClaimsByIndex: PathClaim[][] = [];
  for (const slice of plan.slices) {
    if (slice.ownedPaths.length === 0) {
      noOwnedPathIssues.push({
        code: "NO_OWNED_PATHS",
        message: `slice ${JSON.stringify(slice.id)} owns no paths and therefore has no isolated worker lane`,
        sliceIds: [slice.id],
        paths: [],
      });
    }

    const normalizedForSlice: string[] = [];
    const claimsForSlice: PathClaim[] = [];
    for (const rawPath of slice.ownedPaths) {
      const path = normalizePath(rawPath);
      normalizedForSlice.push(path);

      const invalidReasons = invalidPathReasons(path);
      if (invalidReasons.length > 0) {
        invalidPathIssues.push({
          code: "INVALID_PATH",
          message: `slice ${JSON.stringify(slice.id)} owns invalid path ${JSON.stringify(path)}: ${invalidReasons.join("; ")}`,
          sliceIds: [slice.id],
          paths: [path],
        });
      }

      const containsGlob = /[*?[]/.test(path);
      if (containsGlob) {
        globPathIssues.push({
          code: "GLOB_PATH",
          message: `slice ${JSON.stringify(slice.id)} owns glob path ${JSON.stringify(path)}; owned paths must be literal because a glob cannot be proven disjoint without accessing a filesystem that does not exist yet`,
          sliceIds: [slice.id],
          paths: [path],
        });
      }

      if (invalidReasons.length === 0 && !containsGlob) {
        claimsForSlice.push({ path, sliceId: slice.id });
      }
    }
    normalizedPathsByIndex.push(normalizedForSlice);
    usableClaimsByIndex.push(claimsForSlice);
  }

  // Redundancy inside one lane is still diagnosed, but cannot replace the
  // cross-lane comparison: both defects may need repairing in the same plan.
  for (const claims of usableClaimsByIndex) {
    for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
      const left = claims[leftIndex];
      if (left === undefined) {
        continue;
      }
      for (
        let rightIndex = leftIndex + 1;
        rightIndex < claims.length;
        rightIndex += 1
      ) {
        const right = claims[rightIndex];
        if (right === undefined) {
          continue;
        }
        const conflict = classifyConflict(left.path, right.path);
        if (conflict !== null) {
          conflictIssues.push(
            pathConflictIssue(left, right, conflict, "within"),
          );
        }
      }
    }
  }

  for (
    let leftSliceIndex = 0;
    leftSliceIndex < usableClaimsByIndex.length;
    leftSliceIndex += 1
  ) {
    const leftClaims = usableClaimsByIndex[leftSliceIndex] ?? [];
    for (
      let rightSliceIndex = leftSliceIndex + 1;
      rightSliceIndex < usableClaimsByIndex.length;
      rightSliceIndex += 1
    ) {
      const rightClaims = usableClaimsByIndex[rightSliceIndex] ?? [];
      for (const left of leftClaims) {
        for (const right of rightClaims) {
          const conflict = classifyConflict(left.path, right.path);
          if (conflict !== null) {
            conflictIssues.push(
              pathConflictIssue(left, right, conflict, "cross"),
            );
          }
        }
      }
    }
  }

  const knownIds = new Set(slicesById.keys());
  const dependenciesById = new Map<string, Set<string>>();
  const seenUnknownDependencies = new Set<string>();
  const seenSelfDependencies = new Set<string>();
  for (const slice of plan.slices) {
    if (slice.dependsOn.length > 0) {
      unsupportedDependencyIssues.push({
        code: "DEPENDENCIES_UNSUPPORTED",
        message: `slice ${JSON.stringify(slice.id)} declares dependsOn, but a dependent slice would not see its prerequisite's output; dependency content is not yet implemented, so split this plan into separate runs`,
        sliceIds: [slice.id],
        paths: [],
      });
    }
    let dependencies = dependenciesById.get(slice.id);
    if (dependencies === undefined) {
      dependencies = new Set<string>();
      dependenciesById.set(slice.id, dependencies);
    }
    for (const dependency of slice.dependsOn) {
      if (!knownIds.has(dependency)) {
        const relation = `${slice.id}\0${dependency}`;
        if (!seenUnknownDependencies.has(relation)) {
          seenUnknownDependencies.add(relation);
          unknownDependencyIssues.push({
            code: "UNKNOWN_DEPENDENCY",
            message: `slice ${JSON.stringify(slice.id)} depends on unknown slice ${JSON.stringify(dependency)}`,
            sliceIds: sortedUnique([slice.id]),
            paths: [],
          });
        }
        continue;
      }

      dependencies.add(dependency);
      if (dependency === slice.id) {
        const relation = `${slice.id}\0${dependency}`;
        if (!seenSelfDependencies.has(relation)) {
          seenSelfDependencies.add(relation);
          selfDependencyIssues.push({
            code: "SELF_DEPENDENCY",
            message: `slice ${JSON.stringify(slice.id)} cannot depend on itself`,
            sliceIds: [slice.id],
            paths: [],
          });
        }
      }
    }
  }

  for (const members of findDependencyCycles(knownIds, dependenciesById)) {
    cycleIssues.push({
      code: "DEPENDENCY_CYCLE",
      message: `dependency cycle contains slices: ${members.map((id) => JSON.stringify(id)).join(", ")}`,
      sliceIds: members,
      paths: [],
    });
  }

  let dependencyWaves: readonly (readonly string[])[] = [];
  const graphIsSound =
    duplicateIdIssues.length === 0 &&
    unknownDependencyIssues.length === 0 &&
    selfDependencyIssues.length === 0 &&
    cycleIssues.length === 0;
  // A malformed graph has no meaningful schedule. Keep its graph diagnostics,
  // but do not invent a concurrency width from incomplete or cyclic waves.
  if (graphIsSound) {
    dependencyWaves = buildDependencyWaves(knownIds, dependenciesById);
  }

  const issues = [
    ...emptyIssues,
    ...duplicateIdIssues,
    ...noOwnedPathIssues,
    ...invalidPathIssues,
    ...globPathIssues,
    ...conflictIssues,
    ...unknownDependencyIssues,
    ...selfDependencyIssues,
    ...cycleIssues,
    ...unsupportedDependencyIssues,
  ];
  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const normalizedPaths = new Map<string, readonly string[]>();
  for (const [index, slice] of plan.slices.entries()) {
    normalizedPaths.set(slice.id, normalizedPathsByIndex[index] ?? []);
  }
  return {
    ok: true,
    waves: dependencyWaves,
    normalizedPaths,
  };
}

/**
 * POSIX separator handling is deliberately host-independent; no real cwd
 * exists yet. NFC removes canonical Unicode aliases before any path operation.
 */
function normalizePath(rawPath: string): string {
  const canonicalPath = rawPath.normalize("NFC");
  let normalized = canonicalPath
    .replace(/\/+/g, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
  while (normalized.endsWith("/") && normalized.length > 1) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function invalidPathReasons(path: string): readonly string[] {
  const reasons: string[] = [];
  if (path.trim().length === 0) {
    reasons.push("path must not be empty or whitespace-only");
  }
  if (path.startsWith("/")) {
    reasons.push("absolute paths are not worktree-relative");
  }
  if (/^[A-Za-z]:/.test(path)) {
    reasons.push("Windows drive paths are not worktree-relative");
  }
  if (path.includes("\\")) {
    reasons.push(
      "brigadier targets POSIX paths, where a backslash is ambiguous between a separator and a literal filename character; spell the path with /",
    );
  }
  // This plan-gate rejection is the first of two enforcement layers. Worker
  // spec construction must also reject grammar-breaking paths because specs
  // can be assembled directly without passing through a Plan.
  if (/[(),"']/.test(path)) {
    reasons.push(
      "parentheses, commas, double quotes, and single quotes are not permitted because owned paths are embedded in worker lane permission grammars",
    );
  }
  const controlCodePoints = sortedUnique(
    [...path]
      .map((character) => character.codePointAt(0) ?? 0)
      .filter((codePoint) => codePoint <= 0x1f || codePoint === 0x7f)
      .map(
        (codePoint) =>
          `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
      ),
  );
  for (const codePoint of controlCodePoints) {
    reasons.push(`control character ${codePoint} is not permitted in a path`);
  }
  if (path.split("/").includes("..")) {
    reasons.push(".. segments may escape the worktree root");
  }
  return reasons;
}

/**
 * Uppercase-then-lowercase catches common Unicode case aliases missed by a
 * lowercase-only comparison. This is not complete Unicode case folding or a
 * filesystem collation model: compatibility-equivalent spellings and
 * locale- or filesystem-specific aliases can remain undetected.
 */
function classifyConflict(left: string, right: string): Conflict | null {
  if (left === right) {
    return { reason: "exact", paths: sortedUnique([left, right]) };
  }
  if (isAncestor(left, right) || isAncestor(right, left)) {
    return { reason: "ancestor", paths: sortedUnique([left, right]) };
  }

  const foldedLeft = left.toUpperCase().toLowerCase();
  const foldedRight = right.toUpperCase().toLowerCase();
  if (foldedLeft === foldedRight) {
    return { reason: "case", paths: sortedUnique([left, right]) };
  }
  if (
    isAncestor(foldedLeft, foldedRight) ||
    isAncestor(foldedRight, foldedLeft)
  ) {
    return { reason: "case-ancestor", paths: sortedUnique([left, right]) };
  }
  return null;
}

/** A slash boundary makes ancestry structural rather than a prefix accident. */
function isAncestor(candidate: string, descendant: string): boolean {
  return descendant.startsWith(`${candidate}/`);
}

function pathConflictIssue(
  left: PathClaim,
  right: PathClaim,
  conflict: Conflict,
  scope: "within" | "cross",
): PlanIssue {
  const sliceIds = sortedUnique([left.sliceId, right.sliceId]);
  const claimDescription = conflict.paths
    .map((path) => JSON.stringify(path))
    .join(" and ");
  let message: string;

  if (scope === "within") {
    const prefix = `slice ${JSON.stringify(left.sliceId)} has redundant ownership claims ${claimDescription}`;
    if (conflict.reason === "exact") {
      message = `${prefix}; the same path is listed more than once within one slice`;
    } else if (conflict.reason === "ancestor") {
      message = `${prefix}; one path is a directory ancestor of the other within one slice`;
    } else if (conflict.reason === "case") {
      message = `${prefix}; the paths differ only by case and are not portable across case-sensitive and case-insensitive filesystems`;
    } else {
      message = `${prefix}; one path is a case-insensitive directory ancestor of the other and is not portable across filesystems`;
    }
  } else {
    const prefix = `slices ${sliceIds.map((id) => JSON.stringify(id)).join(" and ")} have conflicting ownership claims ${claimDescription}`;
    if (conflict.reason === "exact") {
      message = `${prefix}; both slices claim the exact same path`;
    } else if (conflict.reason === "ancestor") {
      message = `${prefix}; one path is a directory ancestor of the other`;
    } else if (conflict.reason === "case") {
      message = `${prefix}; the paths differ only by case and are not portable across case-sensitive and case-insensitive filesystems`;
    } else {
      message = `${prefix}; one path is a case-insensitive directory ancestor of the other and is not portable across filesystems`;
    }
  }

  return { code: "PATH_CONFLICT", message, sliceIds, paths: conflict.paths };
}

/** SCCs identify actual cycle members without blaming downstream dependants. */
function findDependencyCycles(
  ids: ReadonlySet<string>,
  dependenciesById: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (id: string): void => {
    const index = nextIndex;
    nextIndex += 1;
    indexById.set(id, index);
    lowLinkById.set(id, index);
    stack.push(id);
    onStack.add(id);

    const dependencies = [...(dependenciesById.get(id) ?? [])].sort();
    for (const dependency of dependencies) {
      if (!indexById.has(dependency)) {
        visit(dependency);
        const currentLowLink = lowLinkById.get(id);
        const dependencyLowLink = lowLinkById.get(dependency);
        if (currentLowLink !== undefined && dependencyLowLink !== undefined) {
          lowLinkById.set(id, Math.min(currentLowLink, dependencyLowLink));
        }
      } else if (onStack.has(dependency)) {
        const currentLowLink = lowLinkById.get(id);
        const dependencyIndex = indexById.get(dependency);
        if (currentLowLink !== undefined && dependencyIndex !== undefined) {
          lowLinkById.set(id, Math.min(currentLowLink, dependencyIndex));
        }
      }
    }

    if (lowLinkById.get(id) !== indexById.get(id)) {
      return;
    }

    const component: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop();
      if (member === undefined) {
        break;
      }
      onStack.delete(member);
      component.push(member);
      if (member === id) {
        break;
      }
    }
    component.sort();
    const soleMember = component[0];
    if (
      component.length > 1 ||
      (soleMember !== undefined &&
        dependenciesById.get(soleMember)?.has(soleMember) === true)
    ) {
      cycles.push(component);
    }
  };

  for (const id of [...ids].sort()) {
    if (!indexById.has(id)) {
      visit(id);
    }
  }
  return cycles.sort((left, right) => {
    const leftKey = left.join("\0");
    const rightKey = right.join("\0");
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
}

function buildDependencyWaves(
  ids: ReadonlySet<string>,
  dependenciesById: ReadonlyMap<string, ReadonlySet<string>>,
): readonly (readonly string[])[] {
  const completed = new Set<string>();
  const remaining = new Set(ids);
  const waves: string[][] = [];

  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) =>
        [...(dependenciesById.get(id) ?? [])].every((dependency) =>
          completed.has(dependency),
        ),
      )
      .sort();
    if (wave.length === 0) {
      break;
    }
    waves.push(wave);
    for (const id of wave) {
      remaining.delete(id);
      completed.add(id);
    }
  }
  return waves;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}
