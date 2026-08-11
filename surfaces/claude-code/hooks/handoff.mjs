#!/usr/bin/env node

/**
 * The handoff hook (design decision #10).
 *
 * A host session that is about to run out of context is exactly the session most
 * tempted to keep grinding rather than delegate. This hook watches for that
 * moment and says the one sentence the doctrine exists to say: stop, write a
 * plan, hand it to `brigadier run`, and keep the review.
 *
 * THE CONTRACT, which is deliberately host-agnostic:
 *   in   one JSON object on stdin, optionally carrying `transcript_path`
 *   out  one JSON object on stdout: {"systemMessage": "<one sentence>"}
 *   exit always 0
 *
 * A hook that fails is worse than a hook that is absent, because it fails inside
 * somebody else's session. So every unhappy path here — unparseable stdin, a
 * missing transcript, an unreadable transcript, a transcript too large to walk —
 * degrades to a weaker message or to silence, and never to a non-zero exit.
 *
 * Zero dependencies, node: builtins only. It is copied verbatim into each host's
 * configuration directory by `brigadier install`, so it cannot import anything
 * from the brigadier tree either.
 */

import { readFileSync, statSync } from "node:fs";

/** Beyond this, the transcript is not walked: a hook must not stall a session. */
const MAX_TRANSCRIPT_BYTES = 8_000_000;

/** A hook whose stdin never ends would wedge the host. This is the escape. */
const DEFAULT_STDIN_TIMEOUT_MS = 2000;

const ADVICE =
  "Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.";

main();

function main() {
  readStdin((raw) => {
    const message = buildMessage(raw);
    if (message !== null) {
      process.stdout.write(`${JSON.stringify({ systemMessage: message })}\n`);
    }
    process.exitCode = 0;
  });
}

/**
 * Null means "say nothing", which is the right answer for input this hook does
 * not understand. Silence is always a legal hook response; a guess is not.
 */
function buildMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const turns = countAssistantTurns(payload.transcript_path);
  return turns === null
    ? `brigadier: this session is out of context. ${ADVICE}`
    : `brigadier: this session is out of context after ${turns} assistant turn(s). ${ADVICE}`;
}

/**
 * Claude Code assistant records and Codex assistant message response items are
 * recognised because any other transcript shape cannot be counted honestly.
 */
function countAssistantTurns(transcriptPath) {
  if (typeof transcriptPath !== "string" || transcriptPath.length === 0) {
    return null;
  }
  try {
    if (statSync(transcriptPath).size > MAX_TRANSCRIPT_BYTES) {
      return null;
    }
    let claudeTurns = 0;
    let codexTurns = 0;
    for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.type === "assistant") {
          claudeTurns += 1;
        }
        const payload = entry.payload;
        if (
          entry.type === "response_item" &&
          typeof payload === "object" &&
          payload !== null &&
          payload.type === "message" &&
          payload.role === "assistant"
        ) {
          codexTurns += 1;
        }
      } catch {
        // A partially written transcript line is normal; skip it.
      }
    }
    const turns = claudeTurns + codexTurns;
    return turns === 0 ? null : turns;
  } catch {
    return null;
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
