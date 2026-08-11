import { describe, expect, test } from "bun:test";
import type { BrigadierConfig } from "../src/config/index.ts";
import { CONFIG_VERSION, parseConfig } from "../src/config/index.ts";
import type {
  Capability,
  Effort,
  QuotaSnapshot,
  QuotaWindow,
  Slice,
  Vendor,
} from "../src/contracts.ts";
import type { ExcludedModel } from "../src/routing/contracts.ts";
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
}

/**
 * Builds fixtures through `parseConfig` rather than as bare literals, so a test
 * can never assert routing behavior against a config the product would reject.
 *
 * `allowDegradedRouting` is a positional argument rather than a field on a
 * vendor spec because that is what it is in the product: one setting for the
 * whole config, not one per vendor. It defaults to `false`, matching the
 * config default, so a test that does not name it is asserting the behaviour a
 * user gets without consenting to anything.
 */
function makeConfig(
  specs: readonly VendorSpec[],
  allowDegradedRouting = false,
): BrigadierConfig {
  return parseConfig({
    version: CONFIG_VERSION,
    secretsConsent: false,
    linkedSecretPaths: [],
    allowDegradedRouting,
    vendors: specs.map((spec) => ({
      vendor: spec.vendor,
      executable: `/usr/local/bin/${spec.vendor}`,
      version: "1.0.0",
      defaultModel: spec.models[0]?.[0] ?? "",
      models: spec.models.map(([id, effortCeiling]) => ({ id, effortCeiling })),
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

/**
 * One quota window. `scope` is the whole point of these fixtures, so it is the
 * first argument and never defaulted.
 */
function quotaWindow(
  scope: QuotaWindow["scope"],
  status: QuotaWindow["status"],
  kind: QuotaWindow["kind"] = "weekly",
): QuotaWindow {
  return {
    kind,
    scope,
    status,
    durationMinutes: null,
    remainingFraction: null,
    resetsAtMs: null,
  };
}

function accountScope(): QuotaWindow["scope"] {
  return { kind: "account" };
}

function tierScope(label: string): QuotaWindow["scope"] {
  return { kind: "model", label };
}

/**
 * A snapshot that actually carries windows.
 *
 * `status` stays explicit rather than being derived here, because the router
 * has to keep working for a snapshot whose account status is not reconstructible
 * from its windows — `normalizeCodexRateLimits` produces exactly that when the
 * payload reports `rateLimitReachedType` with no account-scoped bucket.
 */
function metered(
  vendor: Vendor,
  status: QuotaSnapshot["status"],
  windows: readonly QuotaWindow[],
  observedAtMs = 1_700_000_000_000,
): QuotaSnapshot {
  return { vendor, status, observedAtMs, windows, isUsingOverage: null };
}

function request(
  difficulty: SliceDifficulty,
  extra: {
    requires?: SliceRequirements;
    escalated?: boolean;
    excluded?: readonly ExcludedModel[];
  } = {},
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
    expect(routed.waivedDifficultyFloor).toBe(false);
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

  test("an unranked model cannot establish the difficulty floor without consent", () => {
    const config = makeConfig([
      {
        vendor: "claude",
        models: [
          ["claude-sonnet-5", "high"],
          ["mystery-model-1", "high"],
        ],
      },
    ]);
    const failure = expectFailure(route(request("hard"), input(config)));
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "competence",
        reason: "competence score 74 is below the hard floor of 90",
      },
      {
        vendor: "claude",
        model: "mystery-model-1",
        stage: "competence",
        reason:
          "no competence rule ranks this model, so brigadier cannot establish that it clears the hard floor of 90",
      },
    ]);
  });

  test("degraded-routing consent admits an unranked model and records the waiver", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [["mystery-model-1", "high"]],
        },
      ],
      true,
    );
    const routed = expectRouted(route(request("hard"), input(config)));
    expect(routed.model).toBe("mystery-model-1");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[3]).toBe(
      "competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/mystery-model-1=unranked; picked claude/mystery-model-1 with no competence rank (ranked scores win over unranked models once the floor is waived; unranked ties break on config order)",
    );
  });

  test("consented salvage prefers a ranked model over an unranked model", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["mystery-model-1", "high"],
            ["claude-sonnet-5", "high"],
          ],
        },
      ],
      true,
    );
    const routed = expectRouted(route(request("hard"), input(config)));
    expect(routed.model).toBe("claude-sonnet-5");
    expect(routed.waivedDifficultyFloor).toBe(true);
  });

  test("unranked candidates are ordered by config position", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["mystery-model-b", "high"],
            ["mystery-model-a", "high"],
          ],
        },
      ],
      true,
    );
    const routed = expectRouted(route(request("hard"), input(config)));
    expect(routed.model).toBe("mystery-model-b");
    expect(routed.waivedDifficultyFloor).toBe(true);
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

/* -------------------------- exclusion stage ----------------------------- */

describe("model exclusion", () => {
  test("an escalated retry excludes the failed model and moves up the competence table", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-sol", "xhigh"]] },
      { vendor: "claude", models: [["claude-opus-4-6", "xhigh"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard", {
          escalated: true,
          excluded: [{ vendor: "codex", model: "gpt-5.6-sol" }],
        }),
        input(config),
      ),
    );

    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.effort).toBe("xhigh");
    expect(routed.waivedDifficultyFloor).toBe(false);
    expect(routed.rationale.length).toBe(6);
    expect(routed.rationale[2]).toBe(
      "exclusion: removed 1 of 2 model(s) before competence ranking — codex/gpt-5.6-sol",
    );
    expect(routed.rationale[4]).toBe(
      "competence: hard difficulty sets a floor of 90; eligible claude/claude-opus-4-6=100; picked claude/claude-opus-4-6 — deepest Anthropic reasoning tier: architecture and ambiguous specs (lowest score clearing the floor wins, so the slice costs no more than it has to)",
    );
  });

  test("exclusion keys identity by vendor and model, not model id alone", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["shared-sonnet", "high"]] },
      { vendor: "codex", models: [["shared-sonnet", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard", {
          excluded: [{ vendor: "claude", model: "shared-sonnet" }],
        }),
        input(config),
      ),
    );

    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("shared-sonnet");
    expect(routed.rationale.length).toBe(6);
    expect(routed.rationale[2]).toBe(
      "exclusion: removed 1 of 2 model(s) before competence ranking — claude/shared-sonnet",
    );
  });

  test("excluding every configured model fails with an exclusion diagnosis and full trace", () => {
    const failure = expectFailure(
      route(
        request("standard", {
          excluded: [
            { vendor: "claude", model: "claude-opus-4-6" },
            { vendor: "claude", model: "claude-sonnet-5" },
            { vendor: "claude", model: "claude-haiku-5" },
            { vendor: "codex", model: "gpt-5.6-sol" },
            { vendor: "codex", model: "gpt-5.6-terra" },
          ],
        }),
        input(twoVendorConfig()),
      ),
    );

    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.message).toBe(
      'exclusion removed all 5 model(s) available after quota for slice "slice-1"; no model remains to run it',
    );
    expect(failure.rejected.length).toBe(5);
    expect(failure.rejected.map((entry) => entry.stage)).toEqual([
      "excluded",
      "excluded",
      "excluded",
      "excluded",
      "excluded",
    ]);
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "excluded",
        reason: "claude/claude-opus-4-6 already ran this slice and failed",
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "excluded",
        reason: "claude/claude-sonnet-5 already ran this slice and failed",
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "excluded",
        reason: "claude/claude-haiku-5 already ran this slice and failed",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        stage: "excluded",
        reason: "codex/gpt-5.6-sol already ran this slice and failed",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "excluded",
        reason: "codex/gpt-5.6-terra already ran this slice and failed",
      },
    ]);
  });

  test("an excluded below-floor model cannot reappear through salvage", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-haiku-5", "high"]] },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard", {
          excluded: [{ vendor: "codex", model: "gpt-5.6-terra" }],
        }),
        input(config),
      ),
    );

    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale.length).toBe(6);
    expect(routed.rationale[2]).toBe(
      "exclusion: removed 1 of 2 model(s) before competence ranking — codex/gpt-5.6-terra",
    );
    expect(routed.rationale[4]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40; picked claude/claude-haiku-5 at an actual competence score of 40 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  test("quota takes precedence when the same model is also excluded", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("hard", {
          excluded: [{ vendor: "claude", model: "claude-opus-4-6" }],
        }),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );

    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    expect(failure.rejected.length).toBe(1);
    expect(failure.rejected.map((entry) => entry.stage)).toEqual(["quota"]);
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  test("an exclusion for a model outside the pool is ignored", () => {
    const routed = expectRouted(
      route(
        request("standard", {
          excluded: [{ vendor: "codex", model: "removed-from-config" }],
        }),
        input(twoVendorConfig()),
      ),
    );

    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(false);
    expect(routed.rationale.length).toBe(5);
    expect(routed.rationale).toEqual([
      "pool: 5 model(s) from 2 configured vendor(s) — claude/claude-opus-4-6, claude/claude-sonnet-5, claude/claude-haiku-5, codex/gpt-5.6-sol, codex/gpt-5.6-terra",
      "quota: claude=no snapshot (treated as available), codex=no snapshot (treated as available)",
      "capability: slice requires nothing; 5 of 5 model(s) passed",
      "competence: standard difficulty sets a floor of 60; eligible codex/gpt-5.6-terra=70, claude/claude-sonnet-5=74, codex/gpt-5.6-sol=96, claude/claude-opus-4-6=100; picked codex/gpt-5.6-terra — fast Codex tier: mechanical volume, scaffolding, and boilerplate (lowest score clearing the floor wins, so the slice costs no more than it has to)",
      'effort: base "high" from standard difficulty; no clamp applied; final "high"',
    ]);
  });

  test("an empty or undefined exclusion list is identical to an omitted one", () => {
    const undefinedExcluded = {
      slice: SLICE,
      difficulty: "standard",
      excluded: undefined,
    } as unknown as RoutingRequest;
    const expected = {
      vendor: "codex",
      model: "gpt-5.6-terra",
      effort: "high",
      waivedDifficultyFloor: false,
      rationale: [
        "pool: 5 model(s) from 2 configured vendor(s) — claude/claude-opus-4-6, claude/claude-sonnet-5, claude/claude-haiku-5, codex/gpt-5.6-sol, codex/gpt-5.6-terra",
        "quota: claude=no snapshot (treated as available), codex=no snapshot (treated as available)",
        "capability: slice requires nothing; 5 of 5 model(s) passed",
        "competence: standard difficulty sets a floor of 60; eligible codex/gpt-5.6-terra=70, claude/claude-sonnet-5=74, codex/gpt-5.6-sol=96, claude/claude-opus-4-6=100; picked codex/gpt-5.6-terra — fast Codex tier: mechanical volume, scaffolding, and boilerplate (lowest score clearing the floor wins, so the slice costs no more than it has to)",
        'effort: base "high" from standard difficulty; no clamp applied; final "high"',
      ],
    } as const;

    expect(
      expectRouted(route(request("standard"), input(twoVendorConfig()))),
    ).toEqual(expected);
    expect(
      expectRouted(
        route(request("standard", { excluded: [] }), input(twoVendorConfig())),
      ),
    ).toEqual(expected);
    expect(
      expectRouted(route(undefinedExcluded, input(twoVendorConfig()))),
    ).toEqual(expected);
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
      'effort: base "xhigh" from escalation after a routed model ran the slice and failed; no clamp applied; final "xhigh"',
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
      'effort: base "xhigh" from escalation after a routed model ran the slice and failed; clamped down by the configured effort ceiling "high"; final "high"',
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

  test("command execution removes withheld adapters and routes an available one", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-sonnet-5", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("standard", { requires: { commandExecution: true } }),
        input(config, [
          capability("claude", "claude-sonnet-5"),
          capability("codex", "gpt-5.6-sol"),
        ]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.rationale[2]).toBe(
      "capability: slice requires command execution; 1 of 2 model(s) passed",
    );
  });

  test("command execution fails by name when no available model qualifies", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-sonnet-5", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const failure = expectFailure(
      route(
        request("standard", { requires: { commandExecution: true } }),
        input(config, []),
      ),
    );
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.message).toBe(
      'no configured model can take slice "slice-1" at standard difficulty; 2 model(s) were eliminated',
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "capability",
        reason:
          "claude/claude-sonnet-5 cannot satisfy the command execution requirement because its worker adapter withholds shell access",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        stage: "capability",
        reason:
          "brigadier has no capability record for codex/gpt-5.6-sol, and this slice requires command execution",
      },
    ]);
  });

  test("an absent or false command execution requirement does not re-rank", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-sonnet-5", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const capabilities = [
      capability("claude", "claude-sonnet-5"),
      capability("codex", "gpt-5.6-sol"),
    ];
    const baseline = route(request("standard"), input(config, capabilities));
    const explicitFalse = route(
      request("standard", { requires: { commandExecution: false } }),
      input(config, capabilities),
    );
    expect(explicitFalse).toEqual(baseline);
    expect(expectRouted(baseline).vendor).toBe("claude");
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
    expect(routed.waivedDifficultyFloor).toBe(false);
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
            commandExecution: false,
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
      "quota: claude=no account-wide limit reported (treated as available), codex=account-wide warning (kept in the pool)",
    );
    // A warning removes nothing, so it gets its own line rather than a place in
    // the drop list. The account-wide warning reaches every codex model.
    expect(routed.rationale[2]).toBe(
      "quota warning: codex/gpt-5.6-sol (codex reports its account-wide quota warning), codex/gpt-5.6-terra (codex reports its account-wide quota warning) — kept in the pool, since a warning says a window is close, not that it is spent",
    );
  });

  test("an exhausted vendor drops out and routing continues over what is left", () => {
    const routed = expectRouted(
      route(
        request("standard"),
        input(twoVendorConfig(), [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.waivedDifficultyFloor).toBe(false);
    expect(routed.rationale[1]).toBe(
      "quota: claude=account-wide exhausted, codex=no snapshot (treated as available); dropped 3 of 5 model(s) — claude/claude-opus-4-6 (claude reports its account-wide quota exhausted), claude/claude-sonnet-5 (claude reports its account-wide quota exhausted), claude/claude-haiku-5 (claude reports its account-wide quota exhausted) (a model quota removed is out for this slice; routing continues over what is left)",
    );
  });

  /**
   * The defect this file was rewritten around, in its post-WO-010H form. The
   * router used to hand the slice to an exhausted vendor's configured fallback
   * the moment quota drained, which put a `hard` slice on a score-40 model
   * while a score-96 model from a healthy vendor sat idle.
   *
   * Degraded routing is switched ON here on purpose. Consent is not a taste for
   * weak models: while the ordinary pipeline yields anything at all it decides,
   * the floor stands, and nothing is waived.
   */
  test("a healthy vendor's model takes the slice even with degraded routing allowed", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
        { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
      ],
      true,
    );
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
      waivedDifficultyFloor: false,
      rationale: [
        "pool: 3 model(s) from 2 configured vendor(s) — claude/claude-opus-4-6, claude/claude-haiku-5, codex/gpt-5.6-sol",
        "quota: claude=account-wide exhausted, codex=no snapshot (treated as available); dropped 2 of 3 model(s) — claude/claude-opus-4-6 (claude reports its account-wide quota exhausted), claude/claude-haiku-5 (claude reports its account-wide quota exhausted) (a model quota removed is out for this slice; routing continues over what is left)",
        "capability: slice requires nothing; 1 of 1 model(s) passed",
        "competence: hard difficulty sets a floor of 90; eligible codex/gpt-5.6-sol=96; picked codex/gpt-5.6-sol — deepest Codex reasoning tier: cross-cutting refactors and subtle debugging (lowest score clearing the floor wins, so the slice costs no more than it has to)",
        'effort: base "high" from hard difficulty; no clamp applied; final "high"',
      ],
    });
  });

  /**
   * Consent waives the difficulty floor. It does not create quota.
   *
   * Every model on the machine is drained, so the salvage pool is empty and the
   * waiver has nothing to admit. `ALL_VENDORS_EXHAUSTED` is the honest answer;
   * the alternative burns a worktree and a process spawn to rediscover a limit
   * the vendor already reported.
   */
  test("a fully drained account cannot be salvaged, consent or not", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
      ],
      true,
    );
    const failure = expectFailure(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    // Two entries, one per pooled model, and no third entry for a substitution
    // that was consulted: there is no substitution to consult any more. The
    // reason names the one fact that decides the user's next move — the vendor
    // is empty, so waiting is the remedy and re-running is not.
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * The salvage pool holds only models quota left standing. A `hard` slice with
   * nothing at 90 must not reach a drained account's score-40 `claude-haiku-5`
   * while a healthy score-70 `gpt-5.6-terra` sits idle — and after WO-010H the
   * drained model is not merely outranked, it is not a candidate at all.
   */
  test("a healthy below-floor model is salvaged and a drained one is not", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
    // A score of 70 took a slice whose floor is 90, and the caller is told so.
    expect(routed.waivedDifficultyFloor).toBe(true);
    // The drained claude models are not in the pool to lose: quota removed them
    // and the waiver does not put them back.
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: codex/gpt-5.6-terra=70; picked codex/gpt-5.6-terra at an actual competence score of 70 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  /**
   * A drained model does not enter the salvage pool however good it is.
   *
   * `claude-opus-4-6` scores 100 against `gpt-5.6-terra`'s 70 and loses anyway:
   * `claude` reported its account exhausted, which is a statement about Opus
   * too. A score of 100 on an account with no quota left is worth nothing, and
   * the weaker healthy model is the one that can do the work.
   */
  test("a drained model never outranks a healthy one, however good it is", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: codex/gpt-5.6-terra=70; picked codex/gpt-5.6-terra at an actual competence score of 70 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  test("an equal-scoring healthy model beats a drained one despite config order", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-sonnet-5", "high"]] },
        { vendor: "codex", models: [["codex-sonnet-clone", "high"]] },
      ],
      true,
    );
    // Both match /sonnet/i and score 74, both sit below the hard floor of 90,
    // and the drained one is first in config order — so a config-order tie-break
    // over the whole machine would pick it. The drained model never reaches the
    // salvage pool at all, so codex wins by being the only candidate in it.
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("codex-sonnet-clone");
    expect(routed.waivedDifficultyFloor).toBe(true);
  });

  /**
   * A drained model strong enough to clear the floor on its own is still not
   * usable. Competence was never what stopped it; quota was, and consent waives
   * the floor and nothing else.
   *
   * One configured model, drained, with degraded routing allowed: the smallest
   * possible statement of the rule.
   */
  test("a drained model that clears the floor is still refused", () => {
    const config = makeConfig(
      [{ vendor: "claude", models: [["claude-opus-4-6", "high"]] }],
      true,
    );
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
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * The waiver waives the difficulty floor and nothing else. A salvage winner
   * still runs at an effort its configured ceiling permits, because the ceiling
   * answers "what can this model actually be asked to do", which no amount of
   * consent to degrade changes.
   *
   * Only the Opus tier is drained here, so `claude-haiku-5` is an ordinary
   * pooled model that the hard floor of 90 rejected and the waiver readmits.
   */
  test("the waived floor does not waive the effort ceiling", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "medium"],
          ],
        },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.effort).toBe("medium");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[4]).toBe(
      'effort: base "high" from hard difficulty; clamped down by the configured effort ceiling "medium"; final "medium"',
    );
  });

  test("the only vendor exhausted is ALL_VENDORS_EXHAUSTED", () => {
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
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * Quota is asked before capability, and the trace says so. `claude-haiku-5`
   * here is both drained and unable to read images; only the quota verdict is
   * recorded, because a model quota has removed is gone and grading it on image
   * support afterwards would state a verdict about a run that was never going
   * to happen.
   */
  test("a drained model is rejected on quota before its capability is graded", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
      ],
      true,
    );
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
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    // Exactly two entries, and no `"capability"` entry among them.
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * The effort clamp is not waived on the salvage path either, and a candidate
   * with no runnable rung is dropped from the pool rather than carried into it
   * and skipped later. `claude-haiku-5` is healthy here — only the Opus tier is
   * drained — so it is an ordinary below-floor salvage candidate, and the empty
   * `supportedEfforts` list is the only thing standing between it and the slice.
   *
   * The consequence has to be a failure, not a routed worker at an effort the
   * model does not accept. `NO_CAPABLE_MODEL` rather than `ALL_VENDORS_EXHAUSTED`,
   * because claude still has a healthy model standing and quota is not what
   * stopped this run.
   */
  test("a salvage candidate with no runnable effort is dropped, not routed", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
      ],
      true,
    );
    const failure = expectFailure(
      route(
        request("hard"),
        input(
          config,
          [capability("claude", "claude-haiku-5", { supportedEfforts: [] })],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
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
          'claude reports its weekly window for the "opus" model tier exhausted, so this model cannot run; claude\'s other configured model(s) are unaffected',
      },
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "competence",
        reason: "competence score 40 is below the hard floor of 90",
      },
    ]);
  });

  /**
   * Bar (a): without consent, a slice nothing can reach fails rather than
   * routing. `codex/gpt-5.6-terra` is healthy and scores 70 against a hard floor
   * of 90 — exactly the candidate the waived-floor pool would admit — and
   * `allowDegradedRouting` is off, so it is not admitted and the run fails.
   *
   * `NO_CAPABLE_MODEL` and not `ALL_VENDORS_EXHAUSTED`: codex is healthy and
   * merely too weak for the work, so exhaustion is not what stopped this run
   * and the failure must not claim that it was.
   */
  test("a below-floor healthy model is not routed without degraded-routing consent", () => {
    const config = makeConfig([
      { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
      { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
    ]);
    expect(config.allowDegradedRouting).toBe(false);
    const failure = expectFailure(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
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
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "competence",
        reason: "competence score 70 is below the hard floor of 90",
      },
    ]);
  });

  /**
   * Bar (b): the same machine, the same slice, the flag flipped. One boolean is
   * the entire difference between the failure above and this routed worker, so
   * the flag is the gate and nothing else is.
   */
  test("the same slice routes below the floor once degraded routing is allowed", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-opus-4-6", "high"]] },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(config, [], [snapshot("claude", "exhausted")]),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: codex/gpt-5.6-terra=70; picked codex/gpt-5.6-terra at an actual competence score of 70 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  /**
   * The waiver is a last resort on a healthy machine too. No quota is drained
   * here at all: `claude-haiku-5` scores 40 and `gpt-5.6-terra` scores 70,
   * neither clears the hard floor of 90, and the strongest of them takes the
   * slice. The flag is not about quota, and this is the case that shows it.
   */
  test("degraded routing waives the floor with no quota pressure at all", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-haiku-5", "high"]] },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(route(request("hard"), input(config, [], [])));
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-terra");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40, codex/gpt-5.6-terra=70; picked codex/gpt-5.6-terra at an actual competence score of 70 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  /** Equal below-floor scores break on config order, as everywhere else. */
  test("a salvage tie breaks on config order", () => {
    const first = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-sonnet-4-5", "high"],
            ["claude-sonnet-5", "high"],
          ],
        },
      ],
      true,
    );
    expect(expectRouted(route(request("hard"), input(first))).model).toBe(
      "claude-sonnet-4-5",
    );

    const swapped = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-sonnet-5", "high"],
            ["claude-sonnet-4-5", "high"],
          ],
        },
      ],
      true,
    );
    expect(expectRouted(route(request("hard"), input(swapped))).model).toBe(
      "claude-sonnet-5",
    );
  });

  test("degraded routing is not consulted while a healthy model can take the slice", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
        { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
      ],
      true,
    );
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
    expect(routed.waivedDifficultyFloor).toBe(false);
  });

  test("a model with no runnable effort changes nothing while a healthy model exists", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
        { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
      ],
      true,
    );
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
    expect(routed.waivedDifficultyFloor).toBe(false);
  });

  test("every vendor exhausted is ALL_VENDORS_EXHAUSTED", () => {
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
      "every configured vendor (claude, codex) reports its quota exhausted, so no model is left to run this slice",
    );
    expect(failure.rejected.length).toBe(5);
    expect(failure.rejected[4]).toEqual({
      vendor: "codex",
      model: "gpt-5.6-terra",
      stage: "quota",
      reason:
        "codex reports its account-wide quota exhausted, and every model configured for codex reports the same, so codex has nothing left to run this slice",
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
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        stage: "capability",
        reason: "codex/gpt-5.6-sol does not support image input",
      },
    ]);
  });

  /**
   * Two drained accounts and nothing to salvage, with degraded routing allowed.
   * Consent moves the difficulty floor and nothing else, so a machine with no
   * quota anywhere fails the same way it would without consent — and the trace
   * is exactly one entry per pooled model, with no extra entries for
   * substitutions that no longer exist.
   */
  test("two exhausted vendors salvage nothing, consent or not", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
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
      ],
      true,
    );
    const failure = expectFailure(
      route(
        request("standard"),
        input(
          config,
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude, codex) reports its quota exhausted, so no model is left to run this slice",
    );
    // Four pooled models removed by quota, and nothing after them.
    expect(failure.rejected.length).toBe(4);
    expect(failure.rejected[3]).toEqual({
      vendor: "codex",
      model: "gpt-5.6-terra",
      stage: "quota",
      reason:
        "codex reports its account-wide quota exhausted, and every model configured for codex reports the same, so codex has nothing left to run this slice",
    });
  });

  /**
   * WO-010G's reproduction, kept because the wall it hit is still there.
   *
   * One vendor, one account-scoped weekly window reporting `exhausted`, and a
   * `routine` slice — the easiest work brigadier routes, so nothing but quota
   * can be what stops it. The router used to answer `claude/claude-sonnet-5`
   * because a configured fallback named it, sending a worker into a weekly
   * limit the vendor had already reported. There is no fallback to name any
   * more, and consent is switched on here to prove the waiver does not reopen
   * that door: the floor is not what removed Sonnet, quota is.
   */
  test("an account-wide weekly limit removes every model, consent included", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-sonnet-5", "high"],
          ],
        },
      ],
      true,
    );
    const failure = expectFailure(
      route(
        request("routine"),
        input(
          config,
          [],
          [
            metered("claude", "exhausted", [
              quotaWindow(accountScope(), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide weekly window exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "quota",
        reason:
          "claude reports its account-wide weekly window exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * Both vendors are drained, one holding a model far below the floor and the
   * other a model that would have cleared it. Neither contributes a salvage
   * candidate, because quota removed both, so the two paths meet at the same
   * answer and both vendors appear in the message.
   */
  test("an exhausted vendor offers no salvage candidate", () => {
    const config = makeConfig(
      [
        { vendor: "claude", models: [["claude-haiku-5", "high"]] },
        { vendor: "codex", models: [["gpt-5.6-terra", "high"]] },
      ],
      true,
    );
    const failure = expectFailure(
      route(
        request("standard"),
        input(
          config,
          [],
          [snapshot("claude", "exhausted"), snapshot("codex", "exhausted")],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude, codex) reports its quota exhausted, so no model is left to run this slice",
    );
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-haiku-5",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        stage: "quota",
        reason:
          "codex reports its account-wide quota exhausted, and every model configured for codex reports the same, so codex has nothing left to run this slice",
      },
    ]);
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
      "quota: claude=account-wide exhausted, codex=no snapshot (treated as available); dropped 3 of 5 model(s) — claude/claude-opus-4-6 (claude reports its account-wide quota exhausted), claude/claude-sonnet-5 (claude reports its account-wide quota exhausted), claude/claude-haiku-5 (claude reports its account-wide quota exhausted) (a model quota removed is out for this slice; routing continues over what is left)",
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
        "quota: claude=account-wide warning (kept in the pool), codex=no snapshot (treated as available)",
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

/* -------------------- stage 1: quota, scoped per model ------------------- */

/**
 * WO-010B. WO-010A gave `QuotaWindow` a scope and made `QuotaSnapshot.status`
 * account-derived, which was right and which left the router reading the wrong
 * field: with only `snapshot.status` in hand, an Opus-only weekly limit was
 * invisible and a `hard` slice routed straight into the drained tier.
 *
 * Every test here is about which *model* quota removed, not which vendor.
 */
describe("per-model quota", () => {
  /** claude: opus 100 / sonnet 74. Degraded routing is off unless asked for. */
  function opusAndSonnet(allowDegradedRouting = false) {
    return makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-sonnet-5", "high"],
          ],
        },
      ],
      allowDegradedRouting,
    );
  }

  /**
   * The flagship case of WO-010, and the one WO-010H must not regress.
   *
   * `claude` is healthy as an account, `claude-opus-4-6` is drained, and
   * `claude-sonnet-5` is fine. Nothing special happens: Sonnet was never
   * removed from the pool, so it competes and wins in the ordinary pipeline on
   * merit, the floor is not waived, and `waivedDifficultyFloor` is false.
   *
   * Degraded routing is OFF here, and that is the whole proof. This is the case
   * `quotaFallbackModel` claimed to exist for — "when claude's quota drains,
   * fall back to Sonnet" — and it happens with no fallback configured, no
   * consent given, and no substitution looked up. The field's stated job had
   * already moved into the pipeline; there was nothing left for it to do.
   */
  test("an Opus-only weekly limit routes a standard slice to Sonnet on merit", () => {
    const config = opusAndSonnet();
    expect(config.allowDegradedRouting).toBe(false);
    const routed = expectRouted(
      route(
        request("standard"),
        input(
          config,
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-sonnet-5");
    expect(routed.effort).toBe("high");
    // Nothing was degraded and no consent was spent, so the caller is not told
    // its work ran below the bar. It did not.
    expect(routed.waivedDifficultyFloor).toBe(false);
    // The trace names the tier, not the vendor. Telling a user their whole
    // claude account is spent while Sonnet is sitting there ready is the exact
    // failure the reshape was done to end.
    expect(routed.rationale[1]).toBe(
      'quota: claude=no account-wide limit reported (treated as available); dropped 1 of 2 model(s) — claude/claude-opus-4-6 (claude reports its weekly window for the "opus" model tier exhausted) (a model quota removed is out for this slice; routing continues over what is left)',
    );
    expect(routed.rationale[3]).toBe(
      "competence: standard difficulty sets a floor of 60; eligible claude/claude-sonnet-5=74; picked claude/claude-sonnet-5 — balanced Anthropic tier: well-specified multi-file edits (lowest score clearing the floor wins, so the slice costs no more than it has to)",
    );
  });

  /**
   * The same drained tier at a difficulty Sonnet cannot clear on its own:
   * Sonnet's 74 against the hard floor of 90 that Opus's 100 would have met.
   * Before WO-010B this routed to `claude/claude-opus-4-6` — into the wall.
   *
   * This one genuinely is a degraded run, so it needs consent and it says so.
   * The distinction between this test and the one above is the whole reason
   * `waivedDifficultyFloor` is a better flag than `usedQuotaFallback`: both
   * slices ran on Sonnet while Opus was drained, and only one of them settled
   * for less than the work asked for.
   */
  test("an Opus-only weekly limit routes a hard slice to Sonnet, not into Opus", () => {
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          opusAndSonnet(true),
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.vendor).toBe("claude");
    expect(routed.model).toBe("claude-sonnet-5");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[3]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-sonnet-5=74; picked claude/claude-sonnet-5 at an actual competence score of 74 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  /**
   * The consent gate survives per-model metering. The same drained Opus tier
   * without consent fails rather than quietly running the slice under the floor
   * — decision #21's spirit, carried into the flag that replaced it.
   */
  test("a drained tier without degraded-routing consent leaves the floor in place", () => {
    const failure = expectFailure(
      route(
        request("hard"),
        input(
          opusAndSonnet(),
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    // Not ALL_VENDORS_EXHAUSTED: claude still has a healthy tier standing, and
    // the message would be a lie about what stopped the run.
    expect(failure.reason).toBe("NO_CAPABLE_MODEL");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          'claude reports its weekly window for the "opus" model tier exhausted, so this model cannot run; claude\'s other configured model(s) are unaffected',
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "competence",
        reason: "competence score 74 is below the hard floor of 90",
      },
    ]);
  });

  /**
   * The other direction, so per-model is not read as "model windows only": an
   * ACCOUNT-scoped exhaustion still takes every model of that vendor with it.
   */
  test("an account-scoped exhaustion removes every model of the vendor", () => {
    const failure = expectFailure(
      route(
        request("routine"),
        input(
          opusAndSonnet(),
          [],
          [
            metered("claude", "exhausted", [
              quotaWindow(accountScope(), "exhausted", "rolling"),
              quotaWindow(tierScope("opus"), "available"),
            ]),
          ],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.message).toBe(
      "every configured vendor (claude) reports its quota exhausted, so no model is left to run this slice",
    );
    // Opus's own tier window says `available`; the account window overrules it,
    // because most-severe wins and an account limit constrains every model.
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide rolling window exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "quota",
        reason:
          "claude reports its account-wide rolling window exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * A vendor is exhausted only when EVERY tier it offers is. Two model-scoped
   * windows covering both configured models add up to the same thing an account
   * window would have said, and `ALL_VENDORS_EXHAUSTED` must stay true of its
   * own message when it is returned.
   */
  test("every tier drained separately still adds up to an exhausted vendor", () => {
    const failure = expectFailure(
      route(
        request("routine"),
        input(
          opusAndSonnet(),
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
              quotaWindow(tierScope("sonnet"), "exhausted", "rolling"),
            ]),
          ],
        ),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          'claude reports its weekly window for the "opus" model tier exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice',
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "quota",
        reason:
          'claude reports its rolling window for the "sonnet" model tier exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice',
      },
    ]);
  });

  /**
   * Absence of information is not evidence of exhaustion. A snapshot that
   * reports `unknown` everywhere — no account limit, an Opus window brigadier
   * cannot read — changes nothing about the routing.
   */
  test("unknown windows are treated as available and drop nothing", () => {
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          opusAndSonnet(),
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "unknown"),
              quotaWindow(accountScope(), "unknown"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.waivedDifficultyFloor).toBe(false);
    expect(routed.rationale[1]).toBe(
      "quota: claude=no account-wide limit reported (treated as available)",
    );
  });

  /**
   * R-11 §2b: Codex hands out opaque bucket codenames. Brigadier refuses to
   * guess which model `codex_bengalfox` meters, and the honest consequence of
   * not guessing is a window that constrains nobody — never a window promoted
   * to account scope, which is the defect the reshape removed.
   */
  test("a model-scoped label that matches nothing constrains nobody", () => {
    const config = makeConfig([
      { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
    ]);
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [],
          [
            metered("codex", "unknown", [
              quotaWindow(tierScope("codex_bengalfox"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.rationale[1]).toBe(
      "quota: codex=no account-wide limit reported (treated as available)",
    );
  });

  /**
   * The floor under the window reading. `normalizeCodexRateLimits` reports
   * `status: "exhausted"` from a bare `rateLimitReachedType` when the payload
   * carried no account-scoped window at all, so a router that read windows
   * alone would route straight into a refusal the oracle had already seen.
   */
  test("an account status with no window behind it still removes every model", () => {
    const failure = expectFailure(
      route(
        request("routine"),
        input(opusAndSonnet(), [], [metered("claude", "exhausted", [])]),
      ),
    );
    expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
    expect(failure.rejected).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-4-6",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
      {
        vendor: "claude",
        model: "claude-sonnet-5",
        stage: "quota",
        reason:
          "claude reports its account-wide quota exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice",
      },
    ]);
  });

  /**
   * The equal-timestamp rule, now that "more cautious" is a question asked once
   * per model. Two readings of the same instant can each be the pessimistic one
   * for a different tier, so keeping only the single more cautious snapshot
   * would silently discard the other tier's limit. Both are kept, and the
   * answer must not depend on which the caller concatenated second.
   */
  test("equal timestamps take the most cautious reading of each tier", () => {
    const opusDrained = metered(
      "claude",
      "unknown",
      [quotaWindow(tierScope("opus"), "exhausted")],
      1_000,
    );
    const sonnetDrained = metered(
      "claude",
      "unknown",
      [quotaWindow(tierScope("sonnet"), "exhausted", "rolling")],
      1_000,
    );

    for (const order of [
      [opusDrained, sonnetDrained],
      [sonnetDrained, opusDrained],
    ]) {
      const failure = expectFailure(
        route(request("routine"), input(opusAndSonnet(), [], order)),
      );
      expect(failure.reason).toBe("ALL_VENDORS_EXHAUSTED");
      expect(failure.rejected).toEqual([
        {
          vendor: "claude",
          model: "claude-opus-4-6",
          stage: "quota",
          reason:
            'claude reports its weekly window for the "opus" model tier exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice',
        },
        {
          vendor: "claude",
          model: "claude-sonnet-5",
          stage: "quota",
          reason:
            'claude reports its rolling window for the "sonnet" model tier exhausted, and every model configured for claude reports the same, so claude has nothing left to run this slice',
        },
      ]);
    }
  });

  /**
   * A strictly later reading still wins outright, per tier. Caution settles a
   * tie; it does not keep a stale limit alive after the window reset.
   */
  test("a later reading clears a tier limit an earlier one reported", () => {
    const drained = metered(
      "claude",
      "unknown",
      [quotaWindow(tierScope("opus"), "exhausted")],
      1_000,
    );
    const recovered = metered(
      "claude",
      "unknown",
      [quotaWindow(tierScope("opus"), "available")],
      1_001,
    );
    const routed = expectRouted(
      route(request("hard"), input(opusAndSonnet(), [], [recovered, drained])),
    );
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.waivedDifficultyFloor).toBe(false);
  });

  /**
   * A tier-scoped warning is reported and removes nothing. The line names the
   * tier, so a user who sees a slice slow down can tell which bucket is close.
   */
  test("a tier-scoped warning names the tier and keeps the model", () => {
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          opusAndSonnet(),
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "warning"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.model).toBe("claude-opus-4-6");
    expect(routed.rationale[2]).toBe(
      'quota warning: claude/claude-opus-4-6 (claude reports its weekly window for the "opus" model tier warning) — kept in the pool, since a warning says a window is close, not that it is spent',
    );
  });

  /**
   * WO-010G narrowed what disqualifies a salvage candidate to `exhausted` and
   * nothing else. A `warning` says a window is close, not that it is spent, so a
   * model carrying one stays in the pool, stays eligible for the waived-floor
   * salvage pool, and can take the slice.
   */
  test("a tier-scoped warning does not disqualify a model from salvage", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-haiku-5", "high"],
          ],
        },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
              quotaWindow(tierScope("haiku"), "warning"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.model).toBe("claude-haiku-5");
    expect(routed.effort).toBe("high");
    expect(routed.waivedDifficultyFloor).toBe(true);
    expect(routed.rationale[2]).toBe(
      'quota warning: claude/claude-haiku-5 (claude reports its weekly window for the "haiku" model tier warning) — kept in the pool, since a warning says a window is close, not that it is spent',
    );
    expect(routed.rationale[4]).toBe(
      'competence: the hard difficulty floor of 90 was WAIVED because allowDegradedRouting is enabled — no model could take this slice under the ordinary rules, so the salvage pool was consulted: claude/claude-haiku-5=40; picked claude/claude-haiku-5 at an actual competence score of 40 (highest score wins once the floor is waived, since "cheapest adequate" has no adequate set left to range over; ties break on config order)',
    );
  });

  /**
   * A drained tier on one vendor does not stop a healthy vendor from taking the
   * slice on merit, and no floor is waived when the ordinary pipeline still
   * yields something — degraded routing allowed or not.
   */
  test("a drained tier never preempts a healthy vendor's model", () => {
    const config = makeConfig(
      [
        {
          vendor: "claude",
          models: [
            ["claude-opus-4-6", "high"],
            ["claude-sonnet-5", "high"],
          ],
        },
        { vendor: "codex", models: [["gpt-5.6-sol", "high"]] },
      ],
      true,
    );
    const routed = expectRouted(
      route(
        request("hard"),
        input(
          config,
          [],
          [
            metered("claude", "unknown", [
              quotaWindow(tierScope("opus"), "exhausted"),
            ]),
          ],
        ),
      ),
    );
    expect(routed.vendor).toBe("codex");
    expect(routed.model).toBe("gpt-5.6-sol");
    expect(routed.waivedDifficultyFloor).toBe(false);
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

  /**
   * `src/routing/contracts.ts` states purity as a contract — "no subprocess, no
   * network call, no clock" — and the test above cannot enforce it. Two calls in
   * the same millisecond agree whatever the body does, so `void Date.now()`,
   * `readFileSync`, or a `spawnSync` inside `route` all leave it green. It is
   * kept because a decision that varied between two identical calls would still
   * be a defect; it is simply not the proof it looked like.
   *
   * This one proves half the property structurally: nothing `route` imports can
   * reach a clock, a filesystem, or a subprocess. The list is pinned as an exact
   * array rather than a predicate, so adding `node:fs`, `node:child_process`,
   * `node:perf_hooks`, or a transitively impure sibling module fails here and
   * has to be argued for in a diff. It follows the shape of the same proof over
   * `src/plan/validate.ts` in `test/plan.test.ts` — one technique, so a reader
   * who understands one understands the other.
   *
   * Every specifier below is a type-only or pure-data module: two lines from
   * `../config/contracts.js` (the types and `EFFORT_LADDER`), the frozen root
   * contracts, the quota reader `modelQuotaStatus`, the competence table, and
   * the routing vocabulary. None of them imports anything with an effect.
   */
  test("the router imports nothing that can reach a clock, a file, or a process", async () => {
    const source = await Bun.file(
      new URL("../src/routing/router.ts", import.meta.url),
    ).text();
    const importSpecifiers = [
      ...source.matchAll(/^import(?:[\s\S]*?\sfrom)?\s*["']([^"']+)["'];$/gm),
    ].map((match) => match[1]);

    expect(importSpecifiers).toEqual([
      "../config/contracts.js",
      "../config/contracts.js",
      "../contracts.js",
      "../quota/contracts.js",
      "./competence.js",
      "./contracts.js",
    ]);
  });

  /**
   * The other half, and the half an import list cannot see: `Date` is a global,
   * so reading the clock needs no import at all.
   *
   * `route` is synchronous and takes every observation it uses as data —
   * `QuotaSnapshot.observedAtMs` arrives in `RoutingInput` — so a decision must
   * be a function of its arguments alone. The clock is replaced by a proxy that
   * counts every read and every construction, moved by thirty years between the
   * two calls, and both decisions must come back byte-identical with the counter
   * still at zero.
   *
   * The counter is what makes this a real proof rather than another tautology.
   * Byte-equality alone would still pass for a `route` that read the clock and
   * ignored the value; a zero read count fails the moment `route` so much as
   * touches `Date`, which is exactly the mutation the previous test survived.
   */
  test("routing reads no clock, so a moving Date cannot change a decision", () => {
    const realDate = globalThis.Date;
    let clockReads = 0;
    let fakeNow = 1_700_000_000_000;
    const spyDate = new Proxy(realDate, {
      get(target, property, receiver) {
        if (property === "now") {
          return (): number => {
            clockReads += 1;
            return fakeNow;
          };
        }
        return Reflect.get(target, property, receiver);
      },
      construct(target, args) {
        clockReads += 1;
        return Reflect.construct(target, args);
      },
    });

    let first: RoutingDecision;
    let second: RoutingDecision;
    try {
      globalThis.Date = spyDate;
      first = route(request("hard"), input(twoVendorConfig()));
      // Thirty years pass between the two calls.
      fakeNow = 2_646_000_000_000;
      second = route(request("hard"), input(twoVendorConfig()));
    } finally {
      globalThis.Date = realDate;
    }

    expect(clockReads).toBe(0);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(expectRouted(first).model).toBe("gpt-5.6-sol");
  });
});
