import { describe, expect, test } from "bun:test";
import type { BrigadierConfig } from "../src/config/contracts.js";
import {
  buildCapabilities,
  CAPABILITY_TABLE,
  matchCapabilityRule,
} from "../src/supervisor/capabilities.js";

function config(vendors: BrigadierConfig["vendors"]): BrigadierConfig {
  return {
    version: 2,
    vendors,
    secretsConsent: false,
    allowDegradedRouting: false,
  };
}

describe("capability table", () => {
  test("contains the exact locally established capability rules", () => {
    expect(CAPABILITY_TABLE).toHaveLength(3);
    expect(CAPABILITY_TABLE).toEqual([
      {
        vendor: "claude",
        pattern: /^claude-(?:opus-5|fable-5|sonnet-5|haiku-4-5-20251001)$/i,
        supportedEfforts: ["medium", "high", "xhigh"],
        supportsImageInput: false,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
      {
        vendor: "codex",
        pattern:
          /^(?:gpt-5\.6-(?:sol(?:-wm)?|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?|codex-auto-review)$/i,
        supportedEfforts: ["medium", "high", "xhigh"],
        supportsImageInput: true,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 272_000,
        maxOutputTokens: null,
      },
      {
        vendor: "codex",
        pattern: /^gpt-5\.3-codex-spark$/i,
        supportedEfforts: ["medium", "high", "xhigh"],
        supportsImageInput: false,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 128_000,
        maxOutputTokens: null,
      },
    ]);
  });

  test("matches by vendor and exact model id", () => {
    expect(matchCapabilityRule("codex", "gpt-5.6-sol")).toEqual({
      vendor: "codex",
      pattern:
        /^(?:gpt-5\.6-(?:sol(?:-wm)?|terra|luna)|gpt-5\.5|gpt-5\.4(?:-mini)?|codex-auto-review)$/i,
      supportedEfforts: ["medium", "high", "xhigh"],
      supportsImageInput: true,
      supportsWebSearch: false,
      supportsStructuredOutput: false,
      contextWindowTokens: 272_000,
      maxOutputTokens: null,
    });
    expect(matchCapabilityRule("claude", "gpt-5.6-sol")).toBeNull();
    expect(matchCapabilityRule("codex", "gpt-5.7-future")).toBeNull();
  });
});

describe("buildCapabilities", () => {
  test("emits exact records for matching configured models", () => {
    const capabilities = buildCapabilities(
      config([
        {
          vendor: "claude",
          executable: "claude",
          version: "2.1.224",
          defaultModel: "claude-opus-5",
          models: [{ id: "claude-opus-5", effortCeiling: "high" }],
        },
        {
          vendor: "codex",
          executable: "codex",
          version: "0.145.0",
          defaultModel: "gpt-5.6-sol",
          models: [
            { id: "gpt-5.6-sol", effortCeiling: "xhigh" },
            { id: "gpt-5.3-codex-spark", effortCeiling: "medium" },
          ],
        },
      ]),
    );

    expect(capabilities).toHaveLength(3);
    expect(capabilities).toEqual([
      {
        vendor: "claude",
        model: "claude-opus-5",
        supportedEfforts: ["medium", "high"],
        supportsImageInput: false,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        supportedEfforts: ["medium", "high", "xhigh"],
        supportsImageInput: true,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 272_000,
        maxOutputTokens: null,
      },
      {
        vendor: "codex",
        model: "gpt-5.3-codex-spark",
        supportedEfforts: ["medium"],
        supportsImageInput: false,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 128_000,
        maxOutputTokens: null,
      },
    ]);
  });

  test("emits nothing when a configured model has no matching rule", () => {
    const capabilities = buildCapabilities(
      config([
        {
          vendor: "codex",
          executable: "codex",
          version: "0.145.0",
          defaultModel: "gpt-5.7-future",
          models: [{ id: "gpt-5.7-future", effortCeiling: "high" }],
        },
      ]),
    );

    expect(capabilities).toHaveLength(0);
    expect(capabilities).toEqual([]);
  });

  test("intersects reported efforts with the configured ceiling", () => {
    const capabilities = buildCapabilities(
      config([
        {
          vendor: "codex",
          executable: "codex",
          version: "0.145.0",
          defaultModel: "gpt-5.6-sol",
          models: [{ id: "gpt-5.6-sol", effortCeiling: "medium" }],
        },
      ]),
    );

    expect(capabilities).toHaveLength(1);
    expect(capabilities).toEqual([
      {
        vendor: "codex",
        model: "gpt-5.6-sol",
        supportedEfforts: ["medium"],
        supportsImageInput: true,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 272_000,
        maxOutputTokens: null,
      },
    ]);
  });

  test("does not emit a known table model absent from config", () => {
    const capabilities = buildCapabilities(
      config([
        {
          vendor: "codex",
          executable: "codex",
          version: "0.145.0",
          defaultModel: "gpt-5.6-terra",
          models: [{ id: "gpt-5.6-terra", effortCeiling: "high" }],
        },
      ]),
    );

    expect(capabilities).toHaveLength(1);
    expect(capabilities).toEqual([
      {
        vendor: "codex",
        model: "gpt-5.6-terra",
        supportedEfforts: ["medium", "high"],
        supportsImageInput: true,
        supportsWebSearch: false,
        supportsStructuredOutput: false,
        contextWindowTokens: 272_000,
        maxOutputTokens: null,
      },
    ]);
  });
});
