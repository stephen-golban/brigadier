/**
 * The brigadier plugin for opencode.
 *
 * opencode reads `~/.claude/skills/` natively, so the doctrine itself arrives
 * with `brigadier install claude-code` and is not duplicated here. What a skill
 * cannot do is watch the session, and that is this file's only job: when a
 * session compacts, say the one sentence the doctrine exists to say.
 *
 * Zero dependencies. Plain ESM, node: builtins only, no import from the
 * brigadier tree: this file is copied verbatim into
 * `~/.config/opencode/plugin/brigadier.js` and runs on its own.
 */

/**
 * The bus events emitted when session compaction begins and ends.
 *
 * READ THIS BEFORE FILING A BUG ABOUT THE HOOK NOT FIRING. Both names below
 * were verified on 2026-08-10 against a running opencode 1.18.16 darwin-arm64
 * by fetching GET /doc and enumerating its 89-event OpenAPI union. No live
 * compaction was triggered, so their emission during a real compaction was not
 * observed. Only 1.18.16 was tested, and opencode's event vocabulary is
 * version-dependent. If a future build renames either event, this array remains
 * the one line to change.
 */
export const HANDOFF_EVENT_TYPES = [
  "session.compacted",
  "session.next.compaction.started",
];

const ADVICE =
  "Do not carry the remaining work here — write it as a brigadier plan and run `brigadier run --plan <file>`. A fresh worker gets a clean context; you keep the review.";

/** True for exactly the events in `HANDOFF_EVENT_TYPES`, and for nothing else. */
export function isHandoffEvent(event) {
  if (typeof event !== "object" || event === null) {
    return false;
  }
  return HANDOFF_EVENT_TYPES.includes(event.type);
}

/** The sentence, qualified by the compaction reason when the event provides it. */
export function buildHandoffMessage(reason) {
  if (reason === "auto") {
    return `brigadier: this session is out of context. ${ADVICE}`;
  }
  if (reason === "manual") {
    return `brigadier: this session is being compacted at your request. ${ADVICE}`;
  }
  return `brigadier: this session was compacted. ${ADVICE}`;
}

/**
 * Reads the reason carried by `session.next.compaction.started`. No opencode
 * compaction event carries a turn count, so the plugin does not invent one.
 */
export function readCompactionReason(event) {
  if (event?.type !== "session.next.compaction.started") {
    return null;
  }
  const properties = event?.properties;
  if (typeof properties !== "object" || properties === null) {
    return null;
  }
  return properties.reason === "auto" || properties.reason === "manual"
    ? properties.reason
    : null;
}

export const BrigadierPlugin = async ({ client }) => {
  return {
    /**
     * Never throws. A plugin that throws takes the session's event loop with
     * it, and a doctrine reminder is not worth anybody's session.
     */
    event: async (input) => {
      try {
        const event = input?.event;
        if (!isHandoffEvent(event)) {
          return;
        }
        const message = buildHandoffMessage(readCompactionReason(event));
        process.stderr.write(`${message}\n`);
        await client?.tui?.showToast?.({
          body: { message, variant: "warning" },
        });
      } catch {
        // Every failure stays inside the plugin, including malformed host input.
        return;
      }
    },
  };
};

export default BrigadierPlugin;
