import { describe, expect, test } from "bun:test";
import type { BrigadierConfig } from "../src/config/index.ts";
import { CONFIG_VERSION, parseConfig } from "../src/config/index.ts";
import type {
  Capability,
  Effort,
  QuotaSnapshot,
  Slice,
  Vendor,
} from "../src/contracts.ts";
import type {
  RoutingDecision,
  RoutingInput,
  RoutingRequest,
  SliceDifficulty,
  SliceRequirements,
} from "../src/routing/index.ts";
import {
  COMPETENCE_TABLE,
  DIFFICULTY_FLOORS,
  route,
  scoreModelId,
  UNRANKED_RATIONALE,
  UNRANKED_SCORE,
} from "../src/routing/index.ts";

/* --------------------------------- fixtures ------------------------------ */

const SLICE: Slice = {
  id: "slice-1",
  title: "Rename the config reader",
  prompt: "Rename readConfig to loadConfig and update its callers.",
  ownedPaths: ["src/config/store.ts"],
  dependsOn: [],
};

interface VendorSpec {
  readonly vendor: Vendor;
  readonly models: readonly (readonly [string, Effort])[];
  readonly fallback?: string | null;
}

/**
 * Builds fixtures through `parseConfig` rather than as bare literals, so a test
 * can never assert routing behavior against a config the product would reject.
 */
function makeConfig(specs: readonly VendorSpec[]): BrigadierConfig {
  return parseConfig({
    version: CONFIG_VERSION,
    secretsConsent: false,
    vendors: specs.map((spec) => ({
      vendor: spec.vendor,
      executable: `/usr/local/bin/${spec.vendor}`,
      version: "1.0.0",
      defaultModel: spec.models[0]?.[0] ?? "",
      models: spec.models.map(([id, effortCeiling]) => ({ id, effortCeiling })),
      quotaFallbackModel: spec.fallback ?? null,
    })),
  });
}

/** claude: 100 / 74 / 40, codex: 96 / 70 — every ceiling at `high`. */
function twoVendorConfig(): BrigadierConfig {
  return makeConfig([
    {
      vendor: "claude",
      models: [
        ["claude-opus-4-6", "high"],
        ["claude-sonnet-5", "high"],
        ["claude-haiku-5", "high"],
      ],
    },
    {
      vendor: "codex",
      models: [
        ["gpt-5.6-sol", "high"],
        ["gpt-5.6-terra", "high"],
      ],
    },
  ]);
}

function capability(
  vendor: Vendor,
  model: string,
  overrides: Partial<Capability> = {},
): Capability {
  return {
    vendor,
    model,
    supportedEfforts: ["medium", "high", "xhigh"],
    supportsImageInput: true,
    supportsWebSearch: true,
    supportsStructuredOutput: true,
    contextWindowTokens: 200_000,
    maxOutputTokens: 64_000,
    ...overrides,
  };
}

function snapshot(
  vendor: Vendor,
  status: QuotaSnapshot["status"],
  observedAtMs = 1_700_000_000_000,
): QuotaSnapshot {
  return { vendor, status, observedAtMs, windows: [], isUsingOverage: null };
}

function request(
  difficulty: SliceDifficulty,
  extra: { requires?: SliceRequirements; escalated?: boolean } = {},
): RoutingRequest {
  return { slice: SLICE, difficulty, ...extra };
}

function input(
  config: BrigadierConfig,
  capabilities: readonly Capability[] = [],
  quota: readonly QuotaSnapshot[] = [],
): RoutingInput {
  return { config, capabilities, quota };
}

/** Narrows to the success branch with a readable failure when it is not. */
function expectRouted(decision: RoutingDecision) {
  if (!decision.ok) {
    throw new Error(
      `expected a routed worker, got ${decision.reason}: ${decision.message}`,
    );
  }
  return decision.routed;
}

function expectFailure(decision: RoutingDecision) {
  if (decision.ok) {
    throw new Error(
      `expected a routing failure, got ${decision.routed.vendor}/${decision.routed.model}`,
    );
  }
  return decision;
}

/* ------------------------------ the matrix ------------------------------- */

describe("competence matrix", () => {
  test("scores the model ids brigadier has exercised", () => {
    expect(scoreModelId("claude-opus-4-6").score).toBe(100);
    expect(scoreModelId("gpt-5.6-sol").score).toBe(96);
    expect(scoreModelId("claude-sonnet-5").score).toBe(74);
    expect(scoreModelId("gpt-5.6-terra").score).toBe(70);
    expect(scoreModelId("claude-haiku-5").score).toBe(40);
  });

  test("scores an unknown model id as unranked", () => {
    expect(scoreModelId("mystery-model-1")).toEqual({
      score: UNRANKED_SCORE,
      rationale: UNRANKED_RATIONALE,
    });
    expect(UNRANKED_SCORE).toBe(0);
  });

  test("the difficulty floors sit between the tiers, not on them", () => {
    expect(DIFFICULTY_FLOORS).toEqual({ hard: 90, standard: 60, routine: 0 });
  });

  test("the table is exactly five rules, none scored at the unranked value", () => {
    expect(COMPETENCE_TABLE.length).toBe(5);
    expect(COMPETENCE_TABLE.map((rule) => rule.score)).toEqual([
      100, 96, 74, 70, 40,
    ]);
  });

  /**
   * `readonly` is a compile-time claim and nothing more. Both of these are
   * exported through the package barrel and read live by the router on every
   * call, so before WO-009E a consumer holding the same reference could set
   * `DIFFICULTY_FLOORS.hard = 0` between two identical `route` calls and get two
   * different answers — which breaks `route`'s documented purity and decision
   * #7's premise that the ranking is data that changes only in a diff.
   */
  test("the competence table and its rules are frozen at runtime", () => {
    expect(Object.isFrozen(COMPETENCE_TABLE)).toBe(true);
    expect(COMPETENCE_TABLE.map((rule) => Object.isFrozen(rule))).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(Object.isFrozen(DIFFICULTY_FLOORS)).toBe(true);
  });

  test("mutating the floors throws and leaves the routed decision unchanged", () => {
    expect(
      expectRouted(route(request("hard"), input(twoVendorConfig()))).model,
    ).toBe("gpt-5.6-sol");

    const floors = DIFFICULTY_FLOORS as unknown as Record<string, number>;
    expect(() => {
      floors.hard = 0;
    }).toThrow(TypeError);

    expect(DIFFICULTY_FLOORS.hard).toBe(90);
    // The attack this blocks: with a mutable floor of 0, `hard` would route the
    // cheapest ranked model on the machine instead of the cheapest adequate one.
    expect(
      expectRouted(route(request("hard"), input(twoVendorConfig()))).model,
    ).toBe("gpt-5.6-sol");
  });

  test("mutating a competence rule throws and leaves the routed decision unchanged", () => {
    const rule = COMPETENCE_TABLE[0] as unknown as Record<string, number>;
    expect(() => {
      rule.score = 0;
    }).toThrow(TypeError);
    expect(() => {
      (COMPETENCE_TABLE as unknown as unknown[]).push({
        pattern: /terra/i,
        score: 100,
        rationale: "injected",
      });
    }).toThrow(TypeError);

    expect(COMPETENCE_TABLE.length).toBe(5);
    expect(scoreModelId("claude-opus-4-6").score).toBe(100);
    expect(
      expectRouted(route(request("hard"), input(twoVendorConfig()))).model,
    ).toBe("gpt-5.6-sol");
  });
});

/* ------------------------ stage 3: competence + cost --------------------- */

describe("competence rank and difficulty floor", () => {
  test("hard picks the cheapest model clearing floor 90, not the best overall", () => {
    const routed = expectRouted(
      route(request("hard"), input(twoVendorConfig())),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.effort).toBe("high");
    expect(routed.usedQuotaFallback).toBe(false);
  });

  test("standard picks the cheapest model clearing floor 60", () => {
    const routed = expectRouted(
      route(request("standard"), input(twoVendorConfig())),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
  });

  test("routine picks the cheapest ranked model of all", () => {
    const routed = expectRouted(
      route(request("routine"), input(twoVendorConfig())),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.effort).toBe("medium");
  });

  test("vendor order in config does not change the winner", () => {
    const reversed = makeConfig([
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
      },
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-sonnet-5", "high"],
          ["claude-haiku-5", "high"],
        ],
      },
    ]);
    expect(
      expectRouted(route(request("standard"), input(reversed))).model,
    ).toBe("gpt-5.6-terra");
    expect(expectRouted(route(request("hard"), input(reversed))).model).toBe(
      "gpt-5.6-sol",
    );
  });

  test("equal scores break on position in config.vendors[].models", () => {
    const firstWins = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-sonnet-4-5", "high"],
          ["claude-sonnet-5", "high"],
        ],
      },
    ]);
    expect(
      expectRouted(route(request("standard"), input(firstWins))).model,
    ).toBe("claude-sonnet-4-5");

    const swapped = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-sonnet-5", "high"],
          ["claude-sonnet-4-5", "high"],
        ],
      },
    ]);
    expect(expectRouted(route(request("standard"), input(swapped))).model).toBe(
      "claude-sonnet-5",
    );
  });

  test("an unranked model is held back while a ranked model clears the floor", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-sonnet-5", "high"],
          ["mystery-model-1", "high"],
        ],
      },
    ]);
    expect(expectRouted(route(request("standard"), input(config))).model).toBe(
      "claude-sonnet-5",
    );
  });

  test("an unranked model is admitted only when no ranked model clears the floor", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-sonnet-5", "high"],
          ["mystery-model-1", "high"],
        ],
      },
    ]);
    const routed = expectRouted(route(request("hard"), input(config)));
    expect(routed.model).toBe("mystery-model-1");
    expect(routed.effort).toBe("high");
    expect(routed.rationale[3]).toBe(
      "competence: hard difficulty sets a floor of 90; eligible claude/mystery-model-1=0; picked claude/mystery-model-1 — not in brigadier's competence table; offered because the probe found it, ranked below the tiers brigadier has exercised (no ranked model cleared the floor, so unranked candidates were admitted in config order)",
    );
  });

  test("unranked candidates are ordered by config position", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["mystery-model-b", "high"],
          ["mystery-model-a", "high"],
        ],
      },
    ]);
    expect(expectRouted(route(request("hard"), input(config))).model).toBe(
      "mystery-model-b",
    );
  });

  test("nothing clearing the floor and nothing unranked is NO_CAPABLE_MODEL", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-haiku-5", "high"]] },
    ]);
    const failure = expectFailure(route(request("hard"), input(config)));
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "competence",
        reason: "competence score 40 is below the hard floor of 90",
      },
    ]);
  });
});

/* ----------------------------- stage 4: effort --------------------------- */

describe("effort", () => {
  const xhighCeilings = () =>
    makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "xhigh"],
          ["claude-sonnet-5", "xhigh"],
        ],
      },
      { vendor: "codex", models: [["gpt-5.6-sol", "xhigh"]] },
    ]);

  test("xhigh is unreachable without an escalation, at every difficulty", () => {
    const config = xhighCeilings();
    expect(expectRouted(route(request("hard"), input(config))).effort).toBe(
      "high",
    );
    expect(expectRouted(route(request("standard"), input(config))).effort).toBe(
      "high",
    );
    expect(expectRouted(route(request("routine"), input(config))).effort).toBe(
      "medium",
    );
  });

  test("escalated unlocks xhigh once the ceiling permits it", () => {
    const config = xhighCeilings();
    const routed = expectRouted(
      route(request("hard", { escalated: true }), input(config)),
    );
    expect(routed.effort).toBe("xhigh");
    expect(routed.rationale[4]).toBe(
      'effort: base "xhigh" from escalation after a failed gate; no clamp applied; final "xhigh"',
    );
  });

  test("escalated on a routine slice also starts from xhigh", () => {
    expect(
      expectRouted(
        route(request("routine", { escalated: true }), input(xhighCeilings())),
      ).effort,
    ).toBe("xhigh");
  });

  test("escalated is clamped back down by a high config ceiling", () => {
    const routed = expectRouted(
      route(request("hard", { escalated: true }), input(twoVendorConfig())),
    );
    expect(routed.effort).toBe("high");
    expect(routed.rationale[4]).toBe(
      'effort: base "xhigh" from escalation after a failed gate; clamped down by the configured effort ceiling "high"; final "high"',
    );
  });

  test("the config effort ceiling clamps the base effort down", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "medium"]] },
    ]);
    const routed = expectRouted(route(request("standard"), input(config)));
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("medium");
    expect(routed.rationale[4]).toBe(
      'effort: base "high" from standard difficulty; clamped down by the configured effort ceiling "medium"; final "medium"',
    );
  });

  test("a capability ladder clamps below the config ceiling", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard"),
        input(config, [
          capability("codex", "gpt-5.6-terra", {
            supportedEfforts: ["medium"],
          }),
        ]),
      ),
    );
    expect(routed.effort).toBe("medium");
    expect(routed.rationale[4]).toBe(
      'effort: base "high" from standard difficulty; clamped down by the model\'s supported efforts (medium); final "medium"',
    );
  });

  test("a clamp never raises effort above the base", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "xhigh"]] },
    ]);
    const routed = expectRouted(
      route(
        request("routine"),
        input(config, [
          capability("codex", "gpt-5.6-terra", {
            supportedEfforts: ["medium", "high", "xhigh"],
          }),
        ]),
      ),
    );
    expect(routed.effort).toBe("medium");
  });

  test("a model with no usable rung is skipped and the next candidate takes it", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-sonnet-5", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard"),
        input(config, [
          capability("codex", "gpt-5.6-terra", { supportedEfforts: [] }),
        ]),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-sonnet-5");
    expect(routed.effort).toBe("high");
  });

  test("every candidate failing effort is NO_CAPABLE_MODEL, not a throw", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("standard"),
        input(config, [
          capability("codex", "gpt-5.6-terra", { supportedEfforts: [] }),
        ]),
      ),
    );
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "effort",
        reason:
          'no effort at or below "high" survives its ceiling "high" and its supported efforts (none reported)',
      },
    ]);
  });
});

/* --------------------------- stage 2: capability ------------------------- */

describe("capability filter", () => {
  test("an empty capability list still routes when the slice demands nothing", () => {
    const routed = expectRouted(
      route(request("standard"), input(twoVendorConfig(), [])),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
  });

  test("a demanded capability rejects every model with no capability record", () => {
    const failure = expectFailure(
      route(
        request("standard", { requires: { imageInput: true } }),
        input(twoVendorConfig(), []),
      ),
    );
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected.map((entry) => entry.stage)).toEqual([
      "capability",
      "capability",
      "capability",
      "capability",
      "capability",
    ]);
    expect(failure.rejected[0]).toEqual({
      vendor: "claude",
      model: "claude-opus-4-6",
      stage: "capability",
      reason:
        "brigadier has no capability record for claude/claude-opus-4-6, and this slice requires image input",
    });
  });

  test("a recorded model lacking the demanded capability is rejected", () => {
    const config = makeConfig([
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
      },
    ]);
    const routed = expectRouted(
      route(
        request("standard", { requires: { imageInput: true } }),
        input(config, [
          capability("codex", "gpt-5.6-sol"),
          capability("codex", "gpt-5.6-terra", { supportsImageInput: false }),
        ]),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-sol");
  });

  test("web search and structured output are filtered the same way", () => {
    const config = makeConfig([
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
      },
    ]);
    const capabilities = [
      capability("codex", "gpt-5.6-sol"),
      capability("codex", "gpt-5.6-terra", {
        supportsWebSearch: false,
        supportsStructuredOutput: false,
      }),
    ];
    expect(
      expectRouted(
        route(
          request("standard", { requires: { webSearch: true } }),
          input(config, capabilities),
        ),
      ).model,
    ).toBe("gpt-5.6-sol");
    expect(
      expectRouted(
        route(
          request("standard", { requires: { structuredOutput: true } }),
          input(config, capabilities),
        ),
      ).model,
    ).toBe("gpt-5.6-sol");
  });

  test("a context window below the floor is rejected", () => {
    const config = makeConfig([
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
      },
    ]);
    const routed = expectRouted(
      route(
        request("standard", { requires: { minContextWindowTokens: 150_000 } }),
        input(config, [
          capability("codex", "gpt-5.6-sol", { contextWindowTokens: 400_000 }),
          capability("codex", "gpt-5.6-terra", { contextWindowTokens: 64_000 }),
        ]),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.rationale[2]).toBe(
      "capability: slice requires a context window of at least 150000 tokens; 1 of 2 model(s) passed",
    );
  });

  /**
   * The rule: a requirement removes models, and a requirement brigadier cannot
   * *prove* is met has not been met. A capability record whose
   * `contextWindowTokens` is null is the same answer as having no record at all
   * — "we do not know" — and the branch above already rules that answer is not
   * a yes.
   *
   * This test asserted the opposite until WO-009E: it pinned an unknown window
   * *passing* a 150k floor with an apologetic note, which let a slice that
   * declared it needs 150k tokens be routed to a model brigadier cannot show
   * has them. The failure then lands inside a worker instead of at the filter
   * that exists to catch it.
   */
  test("an unknown context window cannot be proven to meet the floor, so it is rejected", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("standard", { requires: { minContextWindowTokens: 150_000 } }),
        input(config, [
          capability("codex", "gpt-5.6-terra", { contextWindowTokens: null }),
        ]),
      ),
    );
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "capability",
        reason:
          "codex/gpt-5.6-terra reports an unknown context window, so brigadier cannot establish that it meets the required 150000 tokens",
      },
    ]);
  });

  test("a model with a proven window beats one with an unknown window", () => {
    const config = makeConfig([
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
      },
    ]);
    const routed = expectRouted(
      route(
        request("standard", { requires: { minContextWindowTokens: 150_000 } }),
        input(config, [
          capability("codex", "gpt-5.6-sol", { contextWindowTokens: 400_000 }),
          capability("codex", "gpt-5.6-terra", { contextWindowTokens: null }),
        ]),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.rationale[2]).toBe(
      "capability: slice requires a context window of at least 150000 tokens; 1 of 2 model(s) passed",
    );
  });

  test("an unknown context window is harmless when no window is demanded", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard", { requires: { imageInput: true } }),
        input(config, [
          capability("codex", "gpt-5.6-terra", { contextWindowTokens: null }),
        ]),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.usedQuotaFallback).toBe(false);
  });

  test("a zero-token floor is not a demand and does not exclude unrecorded models", () => {
    const routed = expectRouted(
      route(
        request("standard", { requires: { minContextWindowTokens: 0 } }),
        input(twoVendorConfig(), []),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
  });

  test("requirements set to false are not demands", () => {
    const routed = expectRouted(
      route(
        request("standard", {
          requires: {
            imageInput: false,
            webSearch: false,
            structuredOutput: false,
          },
        }),
        input(twoVendorConfig(), []),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
  });

  test("a negative context floor is a caller bug and throws", () => {
    expect(() =>
      route(
        request("standard", { requires: { minContextWindowTokens: -1 } }),
        input(twoVendorConfig()),
      ),
    ).toThrow(
      "minContextWindowTokens must be a non-negative whole number, received -1",
    );
  });
});

/* ------------------------------ stage 1: quota --------------------------- */

describe("quota", () => {
  test("a vendor with no snapshot is treated as available", () => {
    const routed = expectRouted(
      route(request("standard"), input(twoVendorConfig(), [], [])),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.rationale[1]).toBe(
      "quota: claude=no snapshot (treated as available), codex=no snapshot (treated as available)",
    );
  });

  test("unknown and warning keep a vendor in the pool", () => {
    const routed = expectRouted(
      route(
        request("standard"),
        input(
          twoVendorConfig(),
          [],
          [snapshot("claude", "unknown"), snapshot("codex", "warning")],
        ),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.rationale[1]).toBe(
      "quota: claude=unknown (treated as available), codex=warning (kept in the pool)",
    );
  });

  test("an exhausted vendor with a null fallback drops out and routing continues", () => {
    const routed = expectRouted(
      route(
        request("standard"),
        input(twoVendorConfig(), [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.usedQuotaFallback).toBe(false);
    expect(routed.rationale[1]).toBe(
      "quota: claude=exhausted, codex=no snapshot (treated as available); dropped 3 model(s) from claude (quota exhausted; a configured fallback is a last resort, consulted only if no healthy model can take the slice)",
    );
  });

  /**
   * The defect this file was rewritten around. The router used to hand the
   * slice to an exhausted vendor's configured fallback the moment quota
   * drained, which put a `hard` slice on a score-40 model while a score-96
   * model from a healthy vendor sat idle — the difficulty floor bypassed for no
   * reason but the order the stages happened to run in.
   */
  test("a healthy vendor's model beats an exhausted vendor's configured fallback", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed).toEqual({
      vendor: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
      usedQuotaFallback: false,
      rationale: [
        "pool: 3 model(s) from 2 configured vendor(s) — claude/claude-opus-4-6, claude/claude-haiku-5, codex/gpt-5.6-sol",
        "quota: claude=exhausted, codex=no snapshot (treated as available); dropped 2 model(s) from claude (quota exhausted; a configured fallback is a last resort, consulted only if no healthy model can take the slice)",
        "capability: slice requires nothing; 1 of 1 model(s) passed",
        "competence: hard difficulty sets a floor of 90; eligible codex/gpt-5.6-sol=96; picked codex/gpt-5.6-sol — deepest Codex reasoning tier: cross-cutting refactors and subtle debugging (lowest score clearing the floor wins, so the slice costs no more than it has to)",
        'effort: base "high" from hard difficulty; no clamp applied; final "high"',
      ],
    });
  });

  test("the only vendor exhausted routes to its fallback and says the floor was waived", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed).toEqual({
      vendor: "claude",
      model: "claude-haiku-5",
      effort: "high",
      usedQuotaFallback: true,
      rationale: [
        "pool: 2 model(s) from 1 configured vendor(s) — claude/claude-opus-4-6, claude/claude-haiku-5",
        "quota: claude=exhausted; dropped 2 model(s) from claude (quota exhausted; a configured fallback is a last resort, consulted only if no healthy model can take the slice)",
        "capability: slice requires nothing; claude/claude-haiku-5 passed",
        'competence: the hard difficulty floor of 90 was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40 (quota-drained); picked claude/claude-haiku-5 at an actual competence score of 40, quota-drained, because it is exhausted vendor claude\'s configured quota fallback (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)',
        'effort: base "high" from hard difficulty; no clamp applied; final "high"',
      ],
    });
  });

  /**
   * The defect the previous shape cornered into a narrower case. Waiving the
   * floor only for the exhausted vendors' fallbacks meant a `hard` slice with
   * nothing at 90 went to a drained account's score-40 `claude-haiku-5` while a
   * healthy score-70 `gpt-5.6-terra` sat idle — the same preemption mistake the
   * last-resort rule was written to kill, one layer down. The waiver applies to
   * the whole salvage pool, and the healthy 70 wins.
   */
  test("a healthy model below the floor beats a drained vendor's fallback", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
    // The winner is on healthy quota, so this is not a quota fallback run,
    // however drained the rest of the machine is.
    expect(routed.usedQuotaFallback).toBe(false);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40 (quota-drained), codex/gpt-5.6-terra=70 (healthy); picked codex/gpt-5.6-terra at an actual competence score of 70, healthy, because it is on a healthy vendor and was eliminated only by the floor (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)',
    );
  });

  /**
   * The other direction, so "healthy wins" is not read as a rule of its own:
   * health is a tie-break, not a trump. A drained vendor's substitution that
   * outranks everything healthy still takes the slice — that is precisely the
   * case the user configured it for.
   */
  test("a drained fallback that outranks every healthy model still wins", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [["claude-opus-4-6", "high"]],
        fallback: "claude-opus-4-6",
      },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.usedQuotaFallback).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-opus-4-6=100 (quota-drained), codex/gpt-5.6-terra=70 (healthy); picked claude/claude-opus-4-6 at an actual competence score of 100, quota-drained, because it is exhausted vendor claude\'s configured quota fallback (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)',
    );
  });

  test("an equal-scoring healthy model outranks a drained vendor's fallback", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [["claude-sonnet-5", "high"]],
        fallback: "claude-sonnet-5",
      },
      { vendor: "codex", models: [["codex-sonnet-clone", "high"]] },
    ]);
    // Both match /sonnet/i and score 74, both are below the hard floor of 90,
    // and the drained one is first in config order — so only the healthy tie
    // break can pick codex here.
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("codex-sonnet-clone");
    expect(routed.usedQuotaFallback).toBe(false);
  });

  /**
   * Fix 6's counterexample, pinned. `usedQuotaFallback` is a statement about
   * *where* the slice ran, not about the model being weaker than the slice
   * asked for: this winner scores 100 against a floor of 90.
   */
  test("usedQuotaFallback is true even when the substitute clears the floor", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [["claude-opus-4-6", "high"]],
        fallback: "claude-opus-4-6",
      },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.usedQuotaFallback).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-opus-4-6=100 (quota-drained); picked claude/claude-opus-4-6 at an actual competence score of 100, quota-drained, because it is exhausted vendor claude\'s configured quota fallback (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)',
    );
  });

  test("the fallback waives the competence floor but not the effort ceiling", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "medium"],
        ],
        fallback: "claude-haiku-5",
      },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.effort).toBe("medium");
    expect(routed.usedQuotaFallback).toBe(true);
    expect(routed.rationale[4]).toBe(
      'effort: base "high" from hard difficulty; clamped down by the configured effort ceiling "medium"; final "medium"',
    );
  });

  test("the only vendor exhausted with a null fallback is ALL_VENDORS_EXHAUSTED", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, and none has a usable quota fallback configured",
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its quota exhausted and no quota fallback model is configured for it",
      },
    ]);
  });

  test("a fallback that fails the capability filter fails the run instead of routing", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
    ]);
    const failure = expectFailure(
      route(
        request("hard", { requires: { imageInput: true } }),
        input(
          config,
          [
            capability("claude", "claude-haiku-5", {
              supportsImageInput: false,
            }),
            capability("claude", "claude-opus-4-6"),
          ],
          [snapshot("claude", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, and none has a usable quota fallback configured",
    );
    // The quota lines say a fallback exists and did not work; the capability
    // line is the only place the trace says *what was wrong with it*. Losing
    // that entry is losing the answer to "why didn't brigadier use the fallback
    // I configured?", which is the question this trace is printed for.
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          'claude reports its quota exhausted and its configured fallback "claude-haiku-5" cannot take this slice',
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "quota",
        reason:
          'claude reports its quota exhausted and its configured fallback "claude-haiku-5" cannot take this slice',
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "capability",
        reason:
          "as claude's configured quota fallback, claude/claude-haiku-5 does not support image input",
      },
    ]);
  });

  test("a fallback with no runnable effort fails the run and names the effort stage", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
    ]);
    const failure = expectFailure(
      route(
        request("hard"),
        input(
          config,
          [capability("claude", "claude-haiku-5", { supportedEfforts: [] })],
          [snapshot("claude", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.rejected.length).toBe(3);
    expect(failure.rejected[2]).toEqual({
      vendor: "claude",
      model: "claude-haiku-5",
      stage: "effort",
      reason:
        'as claude\'s configured quota fallback, no effort at or below "high" survives its ceiling "high" and its supported efforts (none reported)',
    });
  });

  /**
   * `parseConfig` rejects a `quotaFallbackModel` the vendor does not list, so
   * this config cannot come out of the parser — but `route` accepts a
   * `BrigadierConfig` from any caller, and the alternative to a rejection here
   * is the configured fallback vanishing from the trace with no explanation.
   * Built as a literal deliberately, which is why it does not use `makeConfig`.
   */
  test("a fallback naming a model the vendor does not list is recorded, not skipped", () => {
    const config: BrigadierConfig = {
      version: CONFIG_VERSION,
      secretsConsent: false,
      vendors: [
        {
          vendor: "claude",
          executable: "/usr/local/bin/claude",
          version: "1.0.0",
          defaultModel: "claude-opus-4-6",
          models: [{ id: "claude-opus-4-6", effortCeiling: "high" }],
          quotaFallbackModel: "claude-haiku-5",
        },
      ],
    };
    const failure = expectFailure(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          'claude reports its quota exhausted and its configured fallback "claude-haiku-5" cannot take this slice',
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "quota",
        reason:
          'claude configures "claude-haiku-5" as its quota fallback, but that model is not among its configured models',
      },
    ]);
  });

  test("a healthy vendor below the floor with no fallback anywhere is NO_CAPABLE_MODEL", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    // codex is healthy and merely too weak for a hard slice, so exhaustion is
    // not what stopped this run and the failure must not claim that it was.
    //
    // This also pins the salvage gate. codex/gpt-5.6-terra is exactly the kind
    // of below-floor healthy model the waived-floor pool admits — but no
    // exhausted vendor here configured a fallback, so nothing consented to
    // degrading and `null` still means "fail" (decision #21).
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.message).toBe(
      'no configured model can take slice "slice-1" at hard difficulty; 2 model(s) were eliminated',
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its quota exhausted and no quota fallback model is configured for it",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "competence",
        reason: "competence score 70 is below the hard floor of 90",
      },
    ]);
  });

  test("a fallback is never consulted while a healthy model can take the slice", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard", { requires: { imageInput: true } }),
        input(
          config,
          [
            capability("claude", "claude-haiku-5", {
              supportsImageInput: false,
            }),
            capability("claude", "claude-opus-4-6"),
            capability("codex", "gpt-5.6-sol"),
          ],
          [snapshot("claude", "exhausted")],
        ),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.usedQuotaFallback).toBe(false);
  });

  test("an unrunnable fallback changes nothing while a healthy model exists", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [capability("claude", "claude-haiku-5", { supportedEfforts: [] })],
          [snapshot("claude", "exhausted")],
        ),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.usedQuotaFallback).toBe(false);
  });

  test("every vendor exhausted with no usable fallback is ALL_VENDORS_EXHAUSTED", () => {
    const failure = expectFailure(
      route(
        request("standard"),
        input(
          twoVendorConfig(),
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude, codex) reports its quota exhausted, and none has a usable quota fallback configured",
    );
    expect(failure.rejected.length).toBe(5);
    expect(failure.rejected[4]).toEqual({
      vendor: "codex",
      model: "gpt-5.6-terra",
      stage: "quota",
      reason:
        "codex reports its quota exhausted and no quota fallback model is configured for it",
    });
  });

  test("a quota drop followed by a capability wipeout is NO_CAPABLE_MODEL", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("standard", { requires: { imageInput: true } }),
        input(
          config,
          [capability("codex", "gpt-5.6-sol", { supportsImageInput: false })],
          [snapshot("claude", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its quota exhausted and no quota fallback model is configured for it",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        stage: "capability",
        reason: "codex/gpt-5.6-sol does not support image input",
      },
    ]);
  });

  test("two exhausted vendors: the higher-competence fallback takes the slice", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-opus-4-6", "high"],
          ["claude-haiku-5", "high"],
        ],
        fallback: "claude-haiku-5",
      },
      {
        vendor: "codex",
        models: [
          ["gpt-5.6-sol", "high"],
          ["gpt-5.6-terra", "high"],
        ],
        fallback: "gpt-5.6-terra",
      },
    ]);
    const routed = expectRouted(
      route(
        request("standard"),
        input(
          config,
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    // Salvage, not cost: among two models the user hand-picked as substitutes,
    // the 70 beats the 40 even though the cost stage would invert that ordering
    // for any healthy candidate.
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.usedQuotaFallback).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the standard difficulty floor of 60 was WAIVED — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40 (quota-drained), codex/gpt-5.6-terra=70 (quota-drained); picked codex/gpt-5.6-terra at an actual competence score of 70, quota-drained, because it is exhausted vendor codex\'s configured quota fallback (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; a healthy vendor breaks a tie)',
    );
  });

  test("a fallback below the floor still wins when it is the highest-scoring one", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [["claude-sonnet-5", "high"]],
        fallback: "claude-sonnet-5",
      },
      {
        vendor: "codex",
        models: [["gpt-5.6-terra", "high"]],
        fallback: "gpt-5.6-terra",
      },
    ]);
    // hard sets floor 90: neither substitute would ever clear it, so the choice
    // between them is settled by competence alone.
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-sonnet-5");
    expect(routed.usedQuotaFallback).toBe(true);
  });

  test("an exhausted vendor with no configured fallback offers no candidate", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [["claude-haiku-5", "high"]],
        fallback: "claude-haiku-5",
      },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard"),
        input(
          config,
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.usedQuotaFallback).toBe(true);
  });

  test("the latest snapshot per vendor decides, not array position", () => {
    const stale = snapshot("claude", "exhausted", 1_000);
    const fresh = snapshot("claude", "available", 2_000);
    expect(
      expectRouted(
        route(request("routine"), input(twoVendorConfig(), [], [stale, fresh])),
      ).model,
    ).toBe("claude-haiku-5");
    expect(
      expectRouted(
        route(request("routine"), input(twoVendorConfig(), [], [fresh, stale])),
      ).model,
    ).toBe("claude-haiku-5");
  });

  /**
   * The test above uses *unequal* timestamps, so it stayed green whether the
   * comparison was `>` or `>=` — it could not fail for the claim it made. With
   * `>=` the last equal-timestamp record won, and these same two snapshots in
   * the two orders routed two different models from identical information.
   *
   * The rule now: at an equal instant the more cautious reading wins. Two
   * readings of the same moment that disagree are a reason to be careful, not a
   * reason to trust whichever the caller concatenated second.
   */
  test("equal timestamps resolve the same way in either array order", () => {
    const available = snapshot("claude", "available", 1_000);
    const drained = snapshot("claude", "exhausted", 1_000);

    const forward = expectRouted(
      route(
        request("routine"),
        input(twoVendorConfig(), [], [available, drained]),
      ),
    );
    const reversed = expectRouted(
      route(
        request("routine"),
        input(twoVendorConfig(), [], [drained, available]),
      ),
    );

    expect(forward.model).toBe("gpt-5.6-terra");
    expect(reversed.model).toBe("gpt-5.6-terra");
    expect(forward).toEqual(reversed);
    expect(forward.rationale[1]).toBe(
      "quota: claude=exhausted, codex=no snapshot (treated as available); dropped 3 model(s) from claude (quota exhausted; a configured fallback is a last resort, consulted only if no healthy model can take the slice)",
    );
  });

  test("equal timestamps rank warning above available and below exhausted", () => {
    const warned = snapshot("claude", "warning", 1_000);
    const available = snapshot("claude", "available", 1_000);
    const drained = snapshot("claude", "exhausted", 1_000);

    // warning beats available: the vendor stays in the pool, but the trace says
    // "warning" whichever order the two arrived in.
    for (const order of [
      [available, warned],
      [warned, available],
    ]) {
      const routed = expectRouted(
        route(request("routine"), input(twoVendorConfig(), [], order)),
      );
      expect(routed.model).toBe("claude-haiku-5");
      expect(routed.rationale[1]).toBe(
        "quota: claude=warning (kept in the pool), codex=no snapshot (treated as available)",
      );
    }

    // exhausted beats warning.
    for (const order of [
      [warned, drained],
      [drained, warned],
    ]) {
      expect(
        expectRouted(
          route(request("routine"), input(twoVendorConfig(), [], order)),
        ).model,
      ).toBe("gpt-5.6-terra");
    }
  });

  test("a later reading wins outright, however optimistic it is", () => {
    // Caution only settles a tie. A fresh `available` at a later instant must
    // still beat a stale `exhausted`, or a recovered account would never come
    // back into the pool.
    const drained = snapshot("claude", "exhausted", 1_000);
    const recovered = snapshot("claude", "available", 1_001);
    expect(
      expectRouted(
        route(
          request("routine"),
          input(twoVendorConfig(), [], [recovered, drained]),
        ),
      ).model,
    ).toBe("claude-haiku-5");
  });

  test("a snapshot for a vendor that is not configured is ignored", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    expect(
      expectRouted(
        route(
          request("standard"),
          input(config, [], [snapshot("claude", "exhausted")]),
        ),
      ).model,
    ).toBe("gpt-5.6-terra");
  });
});

/* ------------------------------ stage 0 + trace -------------------------- */

describe("pool and trace", () => {
  test("an empty vendor list is NO_CONFIGURED_MODELS", () => {
    const failure = expectFailure(
      route(request("standard"), input(makeConfig([]))),
    );
    expect(failure.reason).toBe("NO_CONFIGURED_MODELS");
    expect(failure.message).toBe(
      "no configured vendor lists a model; run `brigadier init` before routing work",
    );
    expect(failure.rejected).toEqual([]);
  });

  test("the rationale is one line per stage, in pipeline order", () => {
    const routed = expectRouted(
      route(request("standard"), input(twoVendorConfig())),
    );
    expect(routed.rationale).toEqual([
      "pool: 5 model(s) from 2 configured vendor(s) — claude/claude-opus-4-6, claude/claude-sonnet-5, claude/claude-haiku-5, codex/gpt-5.6-sol, codex/gpt-5.6-terra",
      "quota: claude=no snapshot (treated as available), codex=no snapshot (treated as available)",
      "capability: slice requires nothing; 5 of 5 model(s) passed",
      "competence: standard difficulty sets a floor of 60; eligible codex/gpt-5.6-terra=70, claude/claude-sonnet-5=74, codex/gpt-5.6-sol=96, claude/claude-opus-4-6=100; picked codex/gpt-5.6-terra — fast Codex tier: mechanical volume, scaffolding, and boilerplate (lowest score clearing the floor wins, so the slice costs no more than it has to)",
      'effort: base "high" from standard difficulty; no clamp applied; final "high"',
    ]);
  });

  test("routing the same request twice returns the same decision", () => {
    const first = route(request("hard"), input(twoVendorConfig()));
    const second = route(request("hard"), input(twoVendorConfig()));
    expect(first).toEqual(second);
  });
});
