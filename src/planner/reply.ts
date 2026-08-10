/**
 * The deterministic half of the planner: reading what the model said.
 *
 * NOTHING IN THIS FILE TRUSTS THE MODEL. It decides only which of three shapes
 * the reply is — a plan, a set of questions, or something unreadable — and it
 * refuses to guess between them. In particular an unreadable reply is NEVER
 * reported as `needs_human`: a model that produced garbage has not thoughtfully
 * declined to guess, and letting garbage wear the `needs_human` badge would let
 * a broken planner masquerade as a careful one and teach a user to answer
 * questions that were never asked.
 *
 * The plan object is NOT validated here beyond "it is a JSON object". Every
 * field rule belongs to `parsePlanDocument`, which is the same function
 * `brigadier run --plan <file>` sends a hand-written file through. Adding a
 * second opinion here is exactly how a model-authored plan would start being
 * judged by a different standard from a human-authored one.
 *
 * TOLERANT ABOUT PACKAGING, STRICT ABOUT CONTENT — the same posture, and for the
 * same measured reasons, as the review gate's `parseFindings`: claude 2.1.226
 * wraps its JSON in a ```json fence and codex-cli 0.145.0 emits it bare, and
 * both routinely put prose around it.
 *
 * WHY THIS DOES NOT REUSE `parseFindings`'s SCANNER. That helper lives in
 * `src/supervisor/review.ts`, is deliberately unexported (the supervisor barrel
 * says so, because it is one build's tolerance of one reply format and must stay
 * free to change), and answers a different question — findings, not a
 * discriminated reply. The duplicated part is brace matching, which is not a
 * gate: the gates this file feeds (`parsePlanDocument`, `validatePlan`) have
 * exactly one implementation each, and that is the property that matters.
 */

/**
 * Bounds that make this parser a function of its input's size and nothing else.
 *
 * The scan takes the TAIL of a long reply because the contract asks for the JSON
 * last. `MAX_CANDIDATES` bounds how many `{` positions are tried; the winner is
 * the LAST readable object, so a model that prints the required shape as an
 * example before answering is read as answering rather than as exemplifying.
 */
const MAX_SCAN_CHARS = 256 * 1024;
const MAX_CANDIDATES = 800;

/**
 * How many questions a genuinely ambiguous task may raise, and how long each
 * may be.
 *
 * Both are refusals rather than truncations. A planner with more than twenty
 * questions has not understood the task well enough for its questions to be
 * worth a human's time, and silently dropping the twenty-first would hide the
 * one that mattered.
 */
const MAX_QUESTIONS = 20;
const MAX_QUESTION_CHARS = 500;

/** What the model said, once its packaging is stripped. */
export type PlannerReply =
  | {
      readonly kind: "plan";
      /** The raw `plan` object, untouched, on its way to `parsePlanDocument`. */
      readonly plan: unknown;
    }
  | { readonly kind: "needs-human"; readonly questions: readonly string[] }
  | { readonly kind: "unreadable"; readonly reason: string };

/**
 * Reads one planner reply. Total: every input returns one of the three members.
 *
 * It always terminates. The tail of the reply is scanned once for `{`
 * positions, at most `MAX_CANDIDATES` are tried, each attempt walks forward at
 * most to the end of the window, there is no backtracking, and no regular
 * expression is applied to model-controlled text.
 */
export function parsePlannerReply(text: string): PlannerReply {
  const scanned =
    text.length > MAX_SCAN_CHARS ? text.slice(-MAX_SCAN_CHARS) : text;

  const starts: number[] = [];
  for (let index = 0; index < scanned.length; index += 1) {
    if (scanned[index] === "{") {
      starts.push(index);
    }
  }
  const candidates = starts.slice(-MAX_CANDIDATES);

  // The last readable reply wins, but a *malformed* reply is remembered too:
  // "you said needs_human with an empty question list" is a far more useful
  // sentence than "no JSON object found", and it is only available from the
  // object that tried to be an answer.
  let readable: PlannerReply | null = null;
  let rejected: PlannerReply | null = null;
  for (const start of candidates) {
    const end = matchingBrace(scanned, start);
    if (end === null) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(scanned.slice(start, end + 1));
    } catch {
      continue;
    }
    const reply = readReply(parsed);
    if (reply === null) {
      continue;
    }
    if (reply.kind === "unreadable") {
      rejected = reply;
      continue;
    }
    readable = reply;
  }

  if (readable !== null) {
    return readable;
  }
  if (rejected !== null) {
    return rejected;
  }
  return {
    kind: "unreadable",
    reason:
      'the reply contained no JSON object with a "status" of "plan" or "needs_human"',
  };
}

/**
 * Classifies one parsed JSON object, or null when it is not a planner reply at
 * all.
 *
 * Null and `unreadable` are different answers on purpose. Null means "this
 * object was never trying to be the answer" — an incidental object in prose,
 * which the scan must step over — while `unreadable` means "this object claimed
 * to be the answer and was malformed", which is a fact the user needs.
 */
function readReply(value: unknown): PlannerReply | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const status = record.status;
  if (typeof status !== "string") {
    return null;
  }

  if (status === "plan") {
    const plan = record.plan;
    if (asRecord(plan) === null) {
      return {
        kind: "unreadable",
        reason:
          'the reply said "status":"plan" but its "plan" field was not a JSON object',
      };
    }
    return { kind: "plan", plan };
  }

  if (status === "needs_human") {
    return readQuestions(record.questions);
  }

  return {
    kind: "unreadable",
    reason: `the reply used an unknown status ${JSON.stringify(status)}; the only two are "plan" and "needs_human"`,
  };
}

/**
 * The question list, checked hard.
 *
 * CONTROL CHARACTERS ARE REJECTED RATHER THAN ESCAPED, and this is the one rule
 * here that is a security property rather than a schema. A question is printed
 * to a terminal as prose — unlike the plan, which is re-serialized through
 * `JSON.stringify` and therefore has its control bytes neutralized for free — so
 * an ESC in a question is an ANSI escape sequence the model chose and the user's
 * terminal executes. The rule mirrors `validatePlan`'s own control-character
 * rule on owned paths, deliberately: the same class of byte, refused in the same
 * way, at every boundary where model or file input reaches something that
 * interprets it.
 */
function readQuestions(value: unknown): PlannerReply {
  if (!Array.isArray(value)) {
    return {
      kind: "unreadable",
      reason:
        'the reply said "status":"needs_human" but its "questions" field was not an array',
    };
  }
  if (value.length === 0) {
    return {
      kind: "unreadable",
      reason:
        'the reply said "status":"needs_human" but asked no questions, so there is nothing for a human to answer',
    };
  }
  if (value.length > MAX_QUESTIONS) {
    return {
      kind: "unreadable",
      reason: `the reply asked ${value.length} questions; at most ${MAX_QUESTIONS} are accepted, because a planner with more than that has not understood the task`,
    };
  }

  const questions: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string") {
      return {
        kind: "unreadable",
        reason: `questions[${index}] is not a string`,
      };
    }
    const question = entry.trim();
    if (question === "") {
      return {
        kind: "unreadable",
        reason: `questions[${index}] is empty`,
      };
    }
    if (question.length > MAX_QUESTION_CHARS) {
      return {
        kind: "unreadable",
        reason: `questions[${index}] is ${question.length} characters; at most ${MAX_QUESTION_CHARS} are accepted`,
      };
    }
    const control = firstControlCharacter(question);
    if (control !== null) {
      return {
        kind: "unreadable",
        reason: `questions[${index}] contains control character ${control}, which is not permitted in text brigadier prints to a terminal`,
      };
    }
    questions.push(question);
  }
  return { kind: "needs-human", questions };
}

/** `U+XXXX` for the first C0 or DEL code point, or null when there is none. */
function firstControlCharacter(text: string): string | null {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return null;
}

/**
 * The index of the `}` closing the `{` at `start`, or null when there is none.
 *
 * String state is tracked because a brace inside a JSON string is not a brace,
 * and an escape is tracked because `"\\"` ends a string while `"\""` does not.
 * Getting either wrong would pair the wrong braces and hand `JSON.parse` a
 * substring that happens to be valid JSON of the wrong extent.
 */
function matchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
