/**
 * The brigadier plugin for opencode.
 *
 * opencode reads `~/.claude/skills/` natively, so the doctrine itself arrives
 * with `brigadier install claude-code` and is not duplicated here. What a skill
 * cannot do is watch the session, and that is this file's only job: when a
 * session compacts — when it has run out of context — say the one sentence the
 * doctrine exists to say.
 *
 * Zero dependencies. Plain ESM, node: builtins only, no import from the
 * brigadier tree: this file is copied verbatim into
 * `~/.config/opencode/plugin/brigadier.js` and runs on its own.
 */

/**
 * The bus events that mean "this session has run out of context".
 *
 * READ THIS BEFORE FILING A BUG ABOUT THE HOOK NOT FIRING. These two names were
 * NOT verified against a running opencode; opencode's event vocabulary is
 * version-dependent, and brigadier's verified opencode fact is narrower than
 * people assume — it is that `~/.claude/skills/` and `~/.agents/skills/` are
 * read natively, which is about the doctrine, not about the bus. If your build
 * names the event differently, this array is the one line to change, and
 * `opencode` will log every event type it emits at debug level so you can read
 * the right name off your own machine.
 */
export const HANDOFF_EVENT_TYPES = ["session.compacted", "session.compacting"];

const ADVICE =
  "Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.";

/** True for exactly the events in `HANDOFF_EVENT_TYPES`, and for nothing else. */
export function isHandoffEvent(event) {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  return HANDOFF_EVENT_TYPES.includes(event.type);
}

/** The sentence. `turns` is null when the turn count is not honestly known. */
export function buildHandoffMessage(turns) {
  return typeof turns === "number" && Number.isSafeInteger(turns) && turns >= 0
    ? `brigadier: this session is out of context after ${turns} assistant turn(s). ${ADVICE}`
    : `brigadier: this session is out of context. ${ADVICE}`;
}

/**
 * Reads a turn count off an event without believing anything about its shape.
 * Null whenever the count cannot be established, which is most of the time and
 * is fine: the shorter sentence says the same thing.
 */
export function readTurnCount(event) {
  const properties = event?.properties;
  if (typeof properties !== "object" || properties === null) {
    return null;
  }
  const candidate = properties.messageCount ?? properties.turns;
  return typeof candidate === "number" && Number.isSafeInteger(candidate)
    ? candidate
    : null;
}

export const BrigadierPlugin = async ({ client }) => {
  return {
    /**
     * Never throws. A plugin that throws takes the session's event loop with
     * it, and a doctrine reminder is not worth anybody's session.
     */
    event: async ({ event }) => {
      if (!isHandoffEvent(event)) {
        return;
      }
      const message = buildHandoffMessage(readTurnCount(event));
      process.stderr.write(`${message}\n`);
      try {
        await client?.tui?.showToast?.({
          body: { message, variant: "warning" },
        });
      } catch {
        // The toast is a courtesy. stderr above is the guarantee.
        return;
      }
    },
  };
};

export default BrigadierPlugin;
