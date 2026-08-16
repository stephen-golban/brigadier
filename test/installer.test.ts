import { expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetName,
  checksumFromContents,
  platforms,
  releaseDownloadUrl,
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
      env: {
        ...process.env,
        test_os: operatingSystem,
        test_arch: architecture,
      },
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
  expect(
    checksumFromContents(`${digest}  archive.tar.gz\n`, "archive.tar.gz"),
  ).toBe(digest);
  expect(() =>
    checksumFromContents(`${digest}  other.tar.gz\n`, "archive.tar.gz"),
  ).toThrow("invalid SHA-256 checksum file");
});

test("installer retains checksum verification and guarded interactive setup", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  expect(source).toContain("sha256sum -c");
  expect(source).toContain("shasum -a 256 -c");
  expect(source).toContain("BRIGADIER_SKIP_CHECKSUM=1");
  expect(source).toContain("/dev/tty");
  expect(source).toContain('"$installed_binary" init </dev/tty');
});

test("installer succeeds when interactive setup does not finish", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  const installDirectory = await mkdtemp(
    join(tmpdir(), "brigadier-installer-test-"),
  );
  const script = source
    .replace(
      "if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then",
      "if true; then",
    )
    .replace(
      '"$installed_binary" init </dev/tty',
      '"$installed_binary" init </dev/null',
    )
    .replace(
      'main "$@"',
      `download() { :; }
verify_checksum() { :; }
tar() {
  printf '%s\\n' '#!/bin/sh' 'case "$1" in' '--version) printf "%s\\n" "0.0.0" ;;' 'init) printf "%s\\n" "stub init failed" >&2; exit 1 ;;' 'esac' > "$temporary_directory/brigadier"
  chmod +x "$temporary_directory/brigadier"
}
main "$@"`,
    );

  try {
    const child = Bun.spawn(["sh", "-c", script], {
      env: {
        ...process.env,
        BRIGADIER_INSTALL_DIR: installDirectory,
        BRIGADIER_VERSION: "0.0.0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();

    expect(await child.exited).toBe(0);
    expect(stdout).toContain("Installed brigadier 0.0.0");
    expect(stderr).toContain("stub init failed");
    expect(stderr).toContain("brigadier setup did not finish");
  } finally {
    await rm(installDirectory, { recursive: true, force: true });
  }
});

test("installer replaces a destination symlink without writing through it", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-installer-link-"));
  const installDirectory = join(scratch, "bin");
  const target = join(scratch, "package-manager-brigadier");
  const destination = join(installDirectory, "brigadier");
  const targetContents = "package-manager-owned\n";
  const script = source
    .replace(
      "if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then",
      "if false; then",
    )
    .replace(
      'main "$@"',
      `download() { :; }
verify_checksum() { :; }
tar() {
  printf '%s\\n' '#!/bin/sh' 'case "$1" in' '--version) printf "%s\\n" "0.0.0" ;;' 'esac' > "$temporary_directory/brigadier"
}
main "$@"`,
    );

  try {
    await mkdir(installDirectory);
    await writeFile(target, targetContents);
    await symlink(target, destination);

    const child = Bun.spawn(["sh", "-c", script], {
      env: {
        ...process.env,
        BRIGADIER_INSTALL_DIR: installDirectory,
        BRIGADIER_VERSION: "0.0.0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();

    expect(await child.exited, stderr).toBe(0);
    expect(await readFile(target, "utf8")).toBe(targetContents);
    expect((await lstat(destination)).isSymbolicLink()).toBe(false);
    expect(await readFile(destination, "utf8")).toContain("#!/bin/sh");
    expect(
      (await readdir(installDirectory)).filter((entry) =>
        entry.startsWith(".brigadier.install."),
      ),
    ).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("installer replaces a destination symlink to a directory", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  const scratch = await mkdtemp(
    join(tmpdir(), "brigadier-installer-dir-link-"),
  );
  const installDirectory = join(scratch, "bin");
  const linkedDirectory = join(scratch, "package-manager-bin");
  const destination = join(installDirectory, "brigadier");
  const script = source
    .replace(
      "if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then",
      "if false; then",
    )
    .replace(
      'main "$@"',
      `download() { :; }
verify_checksum() { :; }
tar() {
  printf '%s\\n' '#!/bin/sh' 'case "$1" in' '--version) printf "%s\\n" "0.0.0" ;;' 'esac' > "$temporary_directory/brigadier"
}
main "$@"`,
    );

  try {
    await mkdir(installDirectory);
    await mkdir(linkedDirectory);
    await symlink(linkedDirectory, destination);

    const child = Bun.spawn(["sh", "-c", script], {
      env: {
        ...process.env,
        BRIGADIER_INSTALL_DIR: installDirectory,
        BRIGADIER_VERSION: "0.0.0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();

    expect(await child.exited, stderr).toBe(0);
    const destinationStat = await lstat(destination);
    expect(destinationStat.isSymbolicLink()).toBe(false);
    expect(destinationStat.isFile()).toBe(true);
    expect(destinationStat.mode & 0o111).not.toBe(0);
    expect(await readdir(linkedDirectory)).toEqual([]);
    expect(
      (await readdir(installDirectory)).filter((entry) =>
        entry.startsWith(".brigadier.install."),
      ),
    ).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("installer refuses to replace a real destination directory", async () => {
  const source = await readFile(join(root, "install.sh"), "utf8");
  const scratch = await mkdtemp(join(tmpdir(), "brigadier-installer-dir-"));
  const installDirectory = join(scratch, "bin");
  const destination = join(installDirectory, "brigadier");
  const preservedFile = join(destination, "owned-by-user");
  const preservedContents = "leave this alone\n";
  const script = source
    .replace(
      "if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then",
      "if false; then",
    )
    .replace(
      'main "$@"',
      `download() { :; }
verify_checksum() { :; }
tar() {
  printf '%s\\n' '#!/bin/sh' 'case "$1" in' '--version) printf "%s\\n" "0.0.0" ;;' 'esac' > "$temporary_directory/brigadier"
}
main "$@"`,
    );

  try {
    await mkdir(destination, { recursive: true });
    await writeFile(preservedFile, preservedContents);

    const child = Bun.spawn(["sh", "-c", script], {
      env: {
        ...process.env,
        BRIGADIER_INSTALL_DIR: installDirectory,
        BRIGADIER_VERSION: "0.0.0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(child.stderr).text();

    expect(await child.exited).not.toBe(0);
    expect(stderr).toContain(`${destination} is a directory`);
    expect((await lstat(destination)).isDirectory()).toBe(true);
    expect(await readFile(preservedFile, "utf8")).toBe(preservedContents);
    expect(await readdir(destination)).toEqual(["owned-by-user"]);
    expect(
      (await readdir(installDirectory)).filter((entry) =>
        entry.startsWith(".brigadier.install."),
      ),
    ).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
