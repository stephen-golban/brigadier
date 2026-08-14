import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assetName,
  checksumFromContents,
  platforms,
  releaseDownloadUrl,
  rewriteFormula,
} from "../scripts/update-homebrew-formula";

const root = join(import.meta.dir, "..");

test("installer maps supported uname triples to release asset platforms", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  const cases = [
    ["Darwin", "arm64", "darwin-arm64"],
    ["Darwin", "x86_64", "darwin-x64"],
    ["Linux", "aarch64", "linux-arm64"],
    ["Linux", "amd64", "linux-x64"],
  ] as const;

  for (const [operatingSystem, architecture, expected] of cases) {
    const script = source.replace(
      'main "$@"',
      'uname() { case "$1" in -s) printf "%s\\n" "$test_os" ;; -m) printf "%s\\n" "$test_arch" ;; esac; }; detect_platform; printf "%s\\n" "$platform"',
    );
    const child = Bun.spawn(["sh", "-c", script], {
      env: { ...process.env, test_os: operatingSystem, test_arch: architecture },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(child.stdout).text()).trim()).toBe(expected);
    expect(await child.exited).toBe(0);
  }
});

test("release asset naming and URL construction are deterministic", () => {
  for (const platform of platforms) {
    const asset = assetName("1.2.3", platform);
    expect(asset).toBe(`brigadier-1.2.3-${platform}.tar.gz`);
    expect(releaseDownloadUrl("1.2.3", platform)).toBe(
      `https://github.com/stephen-golban/brigadier/releases/download/v1.2.3/${asset}`,
    );
  }
});

test("checksum parsing accepts only a digest for its expected archive", () => {
  const digest = "a".repeat(64);
  expect(checksumFromContents(`${digest}  archive.tar.gz\n`, "archive.tar.gz")).toBe(digest);
  expect(() => checksumFromContents(`${digest}  other.tar.gz\n`, "archive.tar.gz")).toThrow(
    "invalid SHA-256 checksum file",
  );
});

test("formula updater rewrites all release URLs and checksums without network access", async () => {
  const formula = await readFile(join(root, "Formula/brigadier.rb"), "utf8");
  const checksums = {} as Record<(typeof platforms)[number], string>;
  for (const [index, platform] of platforms.entries()) {
    checksums[platform] = String(index + 1).repeat(64);
  }

  const updated = rewriteFormula(formula, "1.2.3", checksums);
  expect(updated).toContain('version "1.2.3"');
  for (const [index, platform] of platforms.entries()) {
    expect(updated).toContain(releaseDownloadUrl("1.2.3", platform));
    expect(updated).toContain(`sha256 "${String(index + 1).repeat(64)}"`);
  }
});

test("installer retains checksum verification and guarded interactive setup", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  expect(source).toContain("sha256sum -c");
  expect(source).toContain("shasum -a 256 -c");
  expect(source).toContain("BRIGADIER_SKIP_CHECKSUM=1");
  expect(source).toContain("/dev/tty");
  expect(source).toContain('"$installed_binary" init </dev/tty');
});
