/**
 * The untrusted-input boundary for `brigadier run --plan <file>`.
 *
 * A plan file is the one thing a user hands brigadier that decides what gets
 * spawned, where it may write, and how hard the model running it should be. It
 * arrives as bytes on disk with no schema behind it, so everything below the
 * supervisor gets to assume a `PlanDocument` is well-shaped precisely because
 * this module refuses everything that is not.
 *
 * The on-disk document is one object per slice — `difficulty` and `requires`
 * sit beside `id`, `title`, and `prompt`, because that is how a human writes a
 * plan. In memory they are two aligned sequences: the frozen `Slice`/`Plan`
 * shapes from `src/contracts.ts`, the `SliceDirective[]` side channel that
 * exists because `Slice` is frozen and carries no difficulty, and one optional
 * document-wide verification argv. Splitting and validating those values is
 * this module's entire job. It emits one directive per slice, in slice order,
 * which is the invariant every consumer of `PlanDocument` relies on and the
 * reason a `PlanDocument` should never be assembled by hand.
 *
 * THIS MODULE VALIDATES SHAPE AND NOTHING ELSE. Duplicate slice ids, owned-path
 * conflicts, unknown or cyclic dependencies, glob paths, `..` escapes, control
 * characters in paths, and fan-out width are all `validatePlan`'s
 * (`src/plan/validate.ts`), which the orchestrator calls separately so its
 * `PlanIssue[]` reaches the run report as structured data. Do not add cycle
 * detection, path normalization, or a control-character rule here: a second
 * implementation of any of them would drift from the first, and a plan would
 * then be legal or illegal depending on which check happened to run.
 *
 * Like `parseConfig`, this collects every issue and throws once. A user
 * repairing a plan file should see the whole repair, not the first line of it.
 */

import type { Plan, Slice } from "../contracts.js";
import type {
  SliceDifficulty,
  SliceRequirements,
} from "../routing/contracts.js";
import type { PlanDocument, SliceDirective } from "./contracts.js";

/**
 * Raised by `parsePlanDocument`. Carries the full issue list because the message
 * is for a human and the list is for anything that wants to render or count
 * them.
 */
export class PlanDocumentError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid plan document: ${issues.join("; ")}`);
    this.name = "PlanDocumentError";
    this.issues = [...issues];
  }
}

/** The three words a planner may use. Ordered lowest to highest. */
const SLICE_DIFFICULTIES = [
  "routine",
  "standard",
  "hard",
] as const satisfies readonly SliceDifficulty[];

/**
 * Compile-time exhaustiveness for every hand-written list in this file.
 *
 * `Assert` accepts only `true`. `Exactly` is two-directional on purpose: a
 * key list must contain nothing the type does not have AND nothing the type has
 * must be missing from it. The wrapping tuples (`[X] extends [never]`) stop the
 * conditional from distributing over the union, which would otherwise make the
 * check vacuously true.
 *
 * DO NOT REPLACE THESE WITH THE `satisfies` CLAUSES ALONE. `as const satisfies
 * readonly SliceDifficulty[]` proves every element is a real difficulty; it
 * proves nothing about whether every difficulty is listed. A fourth difficulty
 * added to `SliceDifficulty` and forgotten here satisfies that clause and
 * compiles clean — and then every plan using the new word is rejected as
 * invalid, by a parser whose type annotations all look correct. `satisfies`
 * catches a wrong member; only these aliases catch a missing one.
 *
 * The key lists are checked against the types they mirror rather than against
 * literals, so a field added to the frozen `Slice`/`Plan` shapes, or to
 * `SliceRequirements` or `SliceDirective`, fails the build here instead of
 * becoming a silently rejected `unknown key` at runtime.
 */
type Assert<T extends true> = T;
type Exactly<Actual extends string, Expected extends string> = [
  Exclude<Actual, Expected>,
] extends [never]
  ? [Exclude<Expected, Actual>] extends [never]
    ? true
    : false
  : false;

type _DifficultiesAreExhaustive = Assert<
  Exactly<(typeof SLICE_DIFFICULTIES)[number], SliceDifficulty>
>;

const DOCUMENT_KEY_LIST = ["id", "goal", "slices", "verify"] as const;
type _DocumentKeysAreExact = Assert<
  Exactly<(typeof DOCUMENT_KEY_LIST)[number], keyof Plan | "verify">
>;
const DOCUMENT_KEYS: ReadonlySet<string> = new Set(DOCUMENT_KEY_LIST);

const VERIFY_KEY_LIST = ["command"] as const;
type _VerifyKeysAreExact = Assert<
  Exactly<
    (typeof VERIFY_KEY_LIST)[number],
    keyof NonNullable<PlanDocument["verify"]>
  >
>;
const VERIFY_KEYS: ReadonlySet<string> = new Set(VERIFY_KEY_LIST);

/**
 * The frozen `Slice` fields plus the side-channel fields a directive carries.
 * Expressed as that union rather than as seven literals so the list cannot drift
 * from either contract it straddles.
 */
const SLICE_KEY_LIST = [
  "id",
  "title",
  "prompt",
  "ownedPaths",
  "dependsOn",
  "difficulty",
  "requires",
] as const;
type _SliceKeysAreExact = Assert<
  Exactly<
    (typeof SLICE_KEY_LIST)[number],
    keyof Slice | Exclude<keyof SliceDirective, "sliceId">
  >
>;
const SLICE_KEYS: ReadonlySet<string> = new Set(SLICE_KEY_LIST);

const REQUIREMENT_KEY_LIST = [
  "imageInput",
  "webSearch",
  "structuredOutput",
  "commandExecution",
  "minContextWindowTokens",
] as const;
type _RequirementKeysAreExact = Assert<
  Exactly<(typeof REQUIREMENT_KEY_LIST)[number], keyof SliceRequirements>
>;
const REQUIREMENT_KEYS: ReadonlySet<string> = new Set(REQUIREMENT_KEY_LIST);

/**
 * Exactly the boolean-valued requirement keys, derived from the type rather than
 * listed by hand: these are the ones checked with a `typeof === "boolean"` test,
 * and a new boolean capability that never reached this list would be accepted
 * with any value at all.
 */
type BooleanRequirementKey = {
  [K in keyof SliceRequirements]-?: boolean extends SliceRequirements[K]
    ? K
    : never;
}[keyof SliceRequirements];
const REQUIREMENT_FLAGS = [
  "imageInput",
  "webSearch",
  "structuredOutput",
  "commandExecution",
] as const;
type _RequirementFlagsAreExact = Assert<
  Exactly<(typeof REQUIREMENT_FLAGS)[number], BooleanRequirementKey>
>;

/**
 * Validates an untrusted value into a `PlanDocument`, rejecting unknown keys so
 * nothing outside the documented surface can be smuggled into a plan file.
 * Returns fresh, frozen, canonically ordered objects.
 *
 * Every loop below iterates an array whose length is fixed before the loop
 * starts, so the issue count is bounded by the document's own size and a
 * hostile file cannot make this function spin.
 */
export function parsePlanDocument(value: unknown): PlanDocument {
  const root = asRecord(value);
  if (root === null) {
    throw new PlanDocumentError(["plan must be a JSON object"]);
  }

  const issues: string[] = [];
  rejectUnknownKeys(root, DOCUMENT_KEYS, "plan", issues);

  const { id, goal, slices: rawSlices, verify: rawVerify } = root;
  const parsedId = requireNonEmptyString(id, "plan id", issues);
  const parsedGoal = requireNonEmptyString(goal, "plan goal", issues);
  const parsedVerify = parseVerify(
    rawVerify,
    Object.hasOwn(root, "verify"),
    issues,
  );

  // Nothing after this point means anything without a list to walk, so an
  // unusable `slices` ends the parse rather than producing invented per-slice
  // complaints about a value that is not a slice list at all.
  if (!Array.isArray(rawSlices)) {
    issues.push("plan slices must be an array");
    throw new PlanDocumentError(issues);
  }
  if (rawSlices.length === 0) {
    issues.push("plan slices must not be empty");
  }

  const slices: Slice[] = [];
  const directives: SliceDirective[] = [];
  for (const [index, rawSlice] of rawSlices.entries()) {
    const parsed = parseSlice(rawSlice, index, issues);
    if (parsed !== null) {
      slices.push(parsed.slice);
      directives.push(parsed.directive);
    }
  }

  if (issues.length > 0) {
    throw new PlanDocumentError(issues);
  }

  const plan: Plan = Object.freeze({
    id: parsedId,
    goal: parsedGoal,
    slices: Object.freeze(slices),
  });
  return Object.freeze({
    plan,
    directives: Object.freeze(directives),
    ...(parsedVerify === undefined ? {} : { verify: parsedVerify }),
  });
}

/**
 * Parses the document-wide deterministic verification command.
 *
 * A string is refused with a purpose-built diagnostic rather than the generic
 * array error because accepting or splitting shell-shaped text here would turn
 * a data-only argv boundary into a command-injection surface. Every element is
 * copied and frozen so a caller cannot mutate the executable after validation.
 * A whitespace-only executable and a NUL byte anywhere are refused here because
 * the process runner cannot spawn either shape; argument whitespace remains
 * untouched because argv is data, not shell text.
 */
function parseVerify(
  value: unknown,
  present: boolean,
  issues: string[],
): PlanDocument["verify"] | undefined {
  if (!present) {
    return undefined;
  }
  const record = asRecord(value);
  if (record === null) {
    issues.push("plan.verify must be an object");
    return undefined;
  }

  rejectUnknownKeys(record, VERIFY_KEYS, "plan.verify", issues);
  const { command } = record;
  if (typeof command === "string") {
    issues.push(
      'plan.verify.command must use array form such as ["bun", "test"]; shell strings are not accepted',
    );
    return undefined;
  }
  if (!Array.isArray(command)) {
    issues.push("plan.verify.command is required and must be an array");
    return undefined;
  }
  if (command.length === 0) {
    issues.push("plan.verify.command must not be empty");
    return undefined;
  }

  const parsed: string[] = [];
  for (const [index, entry] of command.entries()) {
    if (typeof entry !== "string") {
      issues.push(`plan.verify.command[${index}] must be a non-empty string`);
      continue;
    }
    // The executable must be launchable; arguments are opaque data passed through untouched.
    if (index === 0 && entry.length === 0) {
      issues.push(`plan.verify.command[${index}] must be a non-empty string`);
      continue;
    }
    if (index === 0 && entry.trim().length === 0) {
      issues.push(
        "plan.verify.command[0] must name an executable, not only whitespace",
      );
      continue;
    }
    if (entry.includes("\0")) {
      issues.push(`plan.verify.command[${index}] must not contain a NUL byte`);
      continue;
    }
    parsed.push(entry);
  }
  if (parsed.length !== command.length) {
    return undefined;
  }

  // The executable checks above establish the tuple's executable.
  const [executable, ...arguments_] = parsed;
  if (executable === undefined) {
    return undefined;
  }
  const parsedCommand: [executable: string, ...arguments_: string[]] = [
    executable,
    ...arguments_,
  ];
  return Object.freeze({
    command: Object.freeze(parsedCommand),
  });
}

interface ParsedSlice {
  readonly slice: Slice;
  readonly directive: SliceDirective;
}

/**
 * Returns null when the slice contributed at least one issue, so the caller
 * never assembles a half-parsed slice. Every field is still inspected before
 * returning: a slice with three defects reports three, not one.
 */
function parseSlice(
  value: unknown,
  index: number,
  issues: string[],
): ParsedSlice | null {
  const record = asRecord(value);
  if (record === null) {
    issues.push(`slices[${index}] must be an object`);
    return null;
  }
  const scope = `slices[${index}]`;
  const before = issues.length;
  rejectUnknownKeys(record, SLICE_KEYS, scope, issues);

  // Read every property exactly once. A plan file is JSON today, but this
  // function's parameter is `unknown`, and re-reading a property whose value is
  // a getter is how a validated value and a returned value come apart.
  const { id, title, prompt, ownedPaths, dependsOn, difficulty, requires } =
    record;

  const parsedId = requireNonEmptyString(id, `${scope}.id`, issues);
  const parsedTitle = requireNonEmptyString(title, `${scope}.title`, issues);
  const parsedPrompt = requireNonEmptyString(prompt, `${scope}.prompt`, issues);
  const parsedOwnedPaths = parseOwnedPaths(ownedPaths, scope, issues);
  const parsedDependsOn = parseDependsOn(dependsOn, scope, issues);
  const parsedDifficulty = parseDifficulty(difficulty, scope, issues);
  const parsedRequires = parseRequirements(requires, scope, issues);

  if (issues.length !== before || parsedDifficulty === null) {
    return null;
  }
  return {
    slice: Object.freeze({
      id: parsedId,
      title: parsedTitle,
      prompt: parsedPrompt,
      ownedPaths: Object.freeze(parsedOwnedPaths),
      dependsOn: Object.freeze(parsedDependsOn),
    }),
    directive: Object.freeze(
      parsedRequires === null
        ? { sliceId: parsedId, difficulty: parsedDifficulty }
        : {
            sliceId: parsedId,
            difficulty: parsedDifficulty,
            requires: parsedRequires,
          },
    ),
  };
}

/**
 * A slice with no owned paths has no isolated worker lane, which is why the
 * empty array is rejected here as a shape error rather than deferred: it is not
 * a scheduling conflict, it is a slice that cannot be given a worktree at all.
 */
function parseOwnedPaths(
  value: unknown,
  scope: string,
  issues: string[],
): string[] {
  if (!Array.isArray(value)) {
    issues.push(`${scope}.ownedPaths must be an array`);
    return [];
  }
  if (value.length === 0) {
    issues.push(`${scope}.ownedPaths must not be empty`);
    return [];
  }
  const paths: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || entry.length === 0) {
      issues.push(`${scope}.ownedPaths[${index}] must be a non-empty string`);
      continue;
    }
    paths.push(entry);
  }
  return paths;
}

/**
 * Absent means "depends on nothing", which is the overwhelmingly common case and
 * the only defaulted field in this parser. It is safe to default precisely
 * because the default is the *least* constrained reading: an omitted dependency
 * makes a slice eligible for the first wave, and `validatePlan` still has to
 * accept the resulting graph.
 */
function parseDependsOn(
  value: unknown,
  scope: string,
  issues: string[],
): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(`${scope}.dependsOn must be an array`);
    return [];
  }
  const dependencies: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      issues.push(`${scope}.dependsOn[${index}] must be a string`);
      continue;
    }
    dependencies.push(entry);
  }
  return dependencies;
}

/**
 * Absent is an error, not a default.
 *
 * Difficulty sets the competence floor a model must clear, so a default would
 * pick one silently. Defaulting low routes real work to the cheapest model on
 * the machine and reports success; defaulting high burns the strongest model on
 * a rename. Neither is a guess brigadier is entitled to make on a planner's
 * behalf — a plan that does not say how hard a slice is has not been planned.
 */
function parseDifficulty(
  value: unknown,
  scope: string,
  issues: string[],
): SliceDifficulty | null {
  if (value === undefined) {
    issues.push(
      `${scope}.difficulty is required and must be one of ${SLICE_DIFFICULTIES.join(", ")} — a plan that does not say how hard a slice is has not been planned`,
    );
    return null;
  }
  if (
    typeof value !== "string" ||
    !(SLICE_DIFFICULTIES as readonly string[]).includes(value)
  ) {
    issues.push(
      `${scope}: difficulty ${JSON.stringify(value)} is not one of ${SLICE_DIFFICULTIES.join(", ")}`,
    );
    return null;
  }
  return value as SliceDifficulty;
}

/**
 * Returns null for an absent block, which is different from an empty one only in
 * spelling: a requirement removes models and never ranks them, so "no
 * requirements" and "all requirements false" filter identically. Null is
 * returned so the directive omits the key entirely rather than carrying an empty
 * object that reads like a deliberate statement.
 */
function parseRequirements(
  value: unknown,
  scope: string,
  issues: string[],
): SliceRequirements | null {
  if (value === undefined) {
    return null;
  }
  const record = asRecord(value);
  if (record === null) {
    issues.push(`${scope}.requires must be an object`);
    return null;
  }
  const requiresScope = `${scope}.requires`;
  rejectUnknownKeys(record, REQUIREMENT_KEYS, requiresScope, issues);

  const flags: {
    imageInput?: boolean;
    webSearch?: boolean;
    structuredOutput?: boolean;
    commandExecution?: boolean;
    minContextWindowTokens?: number;
  } = {};
  for (const flag of REQUIREMENT_FLAGS) {
    const flagValue = record[flag];
    if (flagValue === undefined) {
      continue;
    }
    if (typeof flagValue !== "boolean") {
      issues.push(`${requiresScope}.${flag} must be a boolean`);
      continue;
    }
    flags[flag] = flagValue;
  }

  const minContextWindowTokens = record.minContextWindowTokens;
  if (minContextWindowTokens !== undefined) {
    if (
      typeof minContextWindowTokens !== "number" ||
      !Number.isSafeInteger(minContextWindowTokens) ||
      minContextWindowTokens < 0
    ) {
      issues.push(
        `${requiresScope}.minContextWindowTokens must be a non-negative safe integer`,
      );
    } else {
      flags.minContextWindowTokens = minContextWindowTokens;
    }
  }

  return Object.freeze({ ...flags });
}

function requireNonEmptyString(
  value: unknown,
  scope: string,
  issues: string[],
): string {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(`${scope} must be a non-empty string`);
    return "";
  }
  return value;
}

function rejectUnknownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  scope: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(`${scope}: unknown key ${JSON.stringify(key)}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
