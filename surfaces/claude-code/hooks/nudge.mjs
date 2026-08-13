#!/usr/bin/env node

/**
 * The nudge hook.
 *
 * The brigadier skill only fires when the host model happens to notice its
 * description, which is exactly the wrong thing to depend on at the moment a
 * multi-part task arrives. This hook fires on the prompt itself and says one
 * sentence.
 *
 * THE DESIGN CONSTRAINT IS RESTRAINT, NOT COVERAGE. A hook that speaks every
 * turn gets uninstalled within a day, and an uninstalled hook nudges nobody. So
 * it is silent for an ordinary prompt, silent for a question, silent for
 * anything short, and silent for the whole rest of the session once it has
 * spoken. It would rather miss a multi-part task than become noise. Every
 * threshold below is tuned in that direction, and none of them should be
 * loosened without the same reasoning.
 *
 * THE CONTRACT, shared with `handoff.mjs`:
 *   in   one JSON object on stdin, carrying `session_id` and the prompt text
 *   out  one JSON object on stdout, or nothing at all
 *   exit always 0
 *
 * A BRIGADIER WORKER NEVER HEARS THIS. brigadier stamps `BRIGADIER_WORKER=1`
 * into every worker's environment, and a slice prompt is long, enumerated, and
 * full of exactly the words this hook looks for — so without that check the hook
 * would tell a worker to start a second orchestrator from inside its own slice.
 * It is read before stdin is, because it is the cheapest and least breakable
 * place to answer a question that cannot depend on the payload.
 *
 * The object carries the same sentence twice, deliberately. `systemMessage` is
 * shown to the user, so the nudge is never something that happened behind their
 * back. `additionalContext` is what the model actually reads — a hook that only
 * spoke to the human would not make the skill fire, which is the entire job.
 *
 * Zero dependencies, node: builtins only. It is copied verbatim into the host's
 * configuration directory by `brigadier install`, so it cannot import anything
 * from the brigadier tree either.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Below this, a prompt is a request, not a plan. */
const MINIMUM_PROMPT_CHARACTERS = 120;

/** Only the head of a prompt is scanned: a pasted log must not cost a session. */
const MAX_SCANNED_CHARACTERS = 20_000;

/** A hook whose stdin never ends would wedge the host. This is the escape. */
const DEFAULT_STDIN_TIMEOUT_MS = 2000;

/** Where the once-per-session marker lives, under the system temp directory. */
const MARKER_DIRECTORY_NAME = "brigadier-nudge";

const MESSAGE =
  "brigadier: this looks like more than one independent piece of work. Load the brigadier skill, write it as a plan, and run `brigadier run` from here rather than doing it inline. If you are already a brigadier worker running one slice, ignore this and do your slice.";

/**
 * Work that is genuinely spread out. Deliberately narrow: a word that shows up
 * in ordinary conversation about one file does not belong in this list.
 */
const BREADTH_MARKERS = [
  /\ball (?:of )?the\b/i,
  /\bevery\b/i,
  /\beach\b/i,
  /\bacross\b/i,
  /\bthroughout\b/i,
  /\bcodebase\b/i,
  /\bcall sites?\b/i,
  /\bone by one\b/i,
  /\bin parallel\b/i,
  /\bmultiple\b/i,
  /\bseveral\b/i,
];

/** Work that is structurally large. A verb, not a topic. */
const SCOPE_MARKERS = [
  /\brefactor/i,
  /\bmigrat(?:e|es|ing|ion)\b/i,
  /\brenam(?:e|es|ing)\b/i,
  /\brewrit(?:e|es|ing)\b/i,
  /\boverhaul\b/i,
  /\bbackfill\b/i,
  /\bscaffold/i,
];

/**
 * Several distinct targets, actually named: two or more files with extensions,
 * or a quantified plural noun such as "every module" or "all the call sites".
 * This is the difference between work that has independent pieces and work that
 * merely uses a big verb — "refactor `parseCsv` to handle multiple delimiters"
 * is one function in one file, and it matches neither of these.
 */
const NAMED_FILE =
  /\b[\w./-]*\w\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|cs|php|sql|css|scss|html|htm|yml|yaml|toml|sh)\b/gi;
const QUANTIFIED_PLURAL =
  /\b(?:all (?:of )?the|every|each|both|multiple|several|many)\s+(?:\w+[\s-]+){0,2}(?:files?|modules?|packages?|services?|components?|handlers?|endpoints?|routes?|call ?sites?|callers?|tests?|specs?|scripts?|commands?|screens?|pages?|migrations?|queries?|adapters?|providers?|consumers?|usages?|references?|imports?|directories?|folders?|repos?|repositories?|places?|sites?)\b/i;

/**
 * A prompt that opens with one of these and carries a question mark is asking,
 * not assigning — however many bullet points of symptoms it goes on to list.
 */
const QUESTION_OPENERS =
  /^(?:can|could|would|will|shall|should|do|does|did|is|are|was|were|has|have|am|may|might|why|what|when|where|which|who|whom|whose|how)\b/i;

/** A fenced block, terminated or not. Quoted material, never an instruction. */
const FENCED_BLOCK = /```[\s\S]*?```/g;
const UNTERMINATED_FENCE = /```[\s\S]*$/;

/** `- item`, `* item`, `1. item`, `2) item`. */
const ENUMERATION = /^\s*(?:[-*+]\s+|\d+[.)]\s+)\S/;

main();

function main() {
  // A host that stops reading must not turn this hook into a failure; a gone
  // pipe has no useful recovery, so swallow its write error.
  process.stdout.on("error", () => {});
  // FIRST, AND BEFORE STDIN IS EVEN READ. A worker must never be told to run
  // brigadier; see the header. `workerEnvironment` in src/worker/shared.ts is
  // what stamps this, at the spawn, so it cannot be inherited into a genuine
  // top-level session from an ancestor.
  if (process.env.BRIGADIER_WORKER === "1") {
    process.exitCode = 0;
    return;
  }
  readStdin((raw) => {
    if (shouldNudge(raw)) {
      process.stdout.write(
        `${JSON.stringify({
          systemMessage: MESSAGE,
          additionalContext: MESSAGE,
        })}\n`,
      );
    }
    process.exitCode = 0;
  });
}

/**
 * Every unrecognised, unbounded, or already-spent case answers false. Silence is
 * always a legal hook response, and it is the right one whenever this hook is
 * not certain of all three of: the event, the prompt, and the session.
 */
function shouldNudge(raw) {
  if (process.env.BRIGADIER_NUDGE === "off") {
    return false;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return false;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return false;
  }
  if (payload.hook_event_name !== "UserPromptSubmit") {
    return false;
  }
  // `user_input` is the current field name; `prompt` is what older Claude Code
  // builds sent. Reading both costs one line and survives either.
  const text =
    typeof payload.user_input === "string"
      ? payload.user_input
      : typeof payload.prompt === "string"
        ? payload.prompt
        : null;
  if (text === null || !looksMultiPart(text)) {
    return false;
  }
  return claimSession(payload.session_id);
}

/**
 * True only for a prompt that describes work in more than one independent piece.
 *
 * THE TWO REFUSALS COME FIRST, and neither can be argued out of by anything
 * later in the prompt.
 *
 *   A QUESTION IS NEVER ENOUGH — a bug report that opens "why is this failing?"
 *   and then lists three symptoms is three bullet points about ONE thing, so the
 *   question test runs before the list is even counted.
 *
 *   A FENCE IS QUOTED MATERIAL — a pasted config or diff can carry bullets, big
 *   verbs, and plural nouns that the user is showing rather than assigning, so
 *   every fenced block is removed before anything is counted.
 *
 * What is left accepts three shapes: a real list of three; a short list plus a
 * reason to believe it is spread out; or a structural verb AND a breadth word
 * AND several targets actually named. That last conjunct is the one that keeps
 * ordinary English about one function — "refactor `parseCsv` to handle multiple
 * delimiters across quoted fields" — from spending the session's only nudge.
 */
function looksMultiPart(text) {
  const trimmed = text.trim().slice(0, MAX_SCANNED_CHARACTERS);
  if (trimmed.length < MINIMUM_PROMPT_CHARACTERS) {
    return false;
  }
  if (looksLikeQuestion(trimmed)) {
    return false;
  }
  const prose = trimmed
    .replace(FENCED_BLOCK, "\n")
    .replace(UNTERMINATED_FENCE, "\n");
  const enumerated = prose
    .split("\n")
    .filter((line) => ENUMERATION.test(line)).length;
  if (enumerated >= 3) {
    return true;
  }
  const breadth = BREADTH_MARKERS.some((marker) => marker.test(prose));
  const scope = SCOPE_MARKERS.some((marker) => marker.test(prose));
  if (enumerated >= 2 && (breadth || scope)) {
    return true;
  }
  return breadth && scope && namesSeveralTargets(prose);
}

/**
 * Whether this prompt reads as a question rather than an assignment.
 *
 * A trailing `?` is the easy case. The other one is a prompt whose OPENING
 * sentence is the question and whose remainder is evidence — symptoms, a log,
 * a list of things the asker has already tried — which is the shape a bug
 * report takes and is exactly the shape that used to slip through.
 */
function looksLikeQuestion(text) {
  if (text.endsWith("?")) {
    return true;
  }
  const mark = text.indexOf("?");
  if (mark < 0) {
    return false;
  }
  const sentenceEnd = text.search(/[.!]/);
  return sentenceEnd < 0 || mark < sentenceEnd || QUESTION_OPENERS.test(text);
}

/** Two or more named files, or one quantified plural target. */
function namesSeveralTargets(text) {
  if (QUANTIFIED_PLURAL.test(text)) {
    return true;
  }
  const files = text.match(NAMED_FILE);
  return files !== null && new Set(files).size >= 2;
}

/**
 * Records that this session has been nudged, and answers whether this call is
 * the one that got there first.
 *
 * The exclusive create IS the lock: two hooks racing on the same session cannot
 * both succeed. A session with no id cannot be bounded, and a marker that cannot
 * be written cannot bound anything either, so both answer false rather than risk
 * a hook that speaks on every turn.
 */
function claimSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return false;
  }
  // Hashed, not interpolated: a session id is host-supplied and must never
  // become a path segment.
  const marker = join(
    tmpdir(),
    MARKER_DIRECTORY_NAME,
    createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32),
  );
  try {
    mkdirSync(join(tmpdir(), MARKER_DIRECTORY_NAME), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Drains stdin, or gives up on it.
 *
 * THE TEARDOWN IS THE POINT, not the timeout. A host that writes the hook's
 * payload and then forgets to close the pipe leaves this process holding an open
 * read handle, and an open read handle keeps the event loop alive forever — so a
 * timeout that only *fired* would print the message and then hang anyway, which
 * is the exact failure the timeout existed to prevent. `finish` therefore stops
 * listening and releases the stream before it answers.
 */
function readStdin(done) {
  const timeoutMs = readTimeout();
  let text = "";
  let finished = false;
  const onData = (chunk) => {
    text += chunk;
  };
  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    process.stdin.removeListener("data", onData);
    process.stdin.pause();
    process.stdin.unref?.();
    done(text);
  };
  const timer = setTimeout(finish, timeoutMs);
  timer.unref?.();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", onData);
  process.stdin.on("end", finish);
  process.stdin.on("error", finish);
}

function readTimeout() {
  const raw = process.env.BRIGADIER_HANDOFF_STDIN_TIMEOUT_MS;
  if (raw === undefined || !/^[0-9]+$/.test(raw)) {
    return DEFAULT_STDIN_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_STDIN_TIMEOUT_MS;
}
