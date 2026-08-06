import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type CreatedWorktree,
  GitWorktreeEngine,
  LinkedSecretCommitError,
} from "../src/worktree/index.ts";

const TEST_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 5_000;
const SECRET = "literal-super-secret-value";
const scratchParent = resolve(import.meta.dir, "../src/worktree");

interface Fixture {
  readonly root: string;
  readonly repository: string;
  readonly engine: GitWorktreeEngine;
  readonly worktrees: CreatedWorktree[];
}

describe("GitWorktreeEngine", () => {
  test(
    "captures tracked and untracked work in a scratch base without touching the user index",
    async () => {
      await withFixture(async ({ repository, engine }) => {
        const session = await prepare(engine, repository, "capture");

        expect(
          await gitText(repository, [
            "show",
            `${session.baseCommit}:tracked.txt`,
          ]),
        ).toBe("tracked in progress\n");
        expect(
          await gitText(repository, [
            "show",
            `${session.baseCommit}:untracked.txt`,
          ]),
        ).toBe("untracked in progress\n");
        expect(
          await gitText(repository, [
            "show",
            `${session.baseCommit}:base-leak.txt`,
          ]),
        ).toBe("base observed=[REDACTED]\n");
        expect(
          await gitText(repository, ["diff", "--cached", "--name-only"]),
        ).toBe("");
        expect(await gitText(repository, ["branch", "--show-current"])).toBe(
          "main\n",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "branches an isolated worktree from the captured base and seeds ignored dependencies",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "seed",
        );
        const worktree = await createWorktree(fixture, session, 1);

        expect(await gitText(worktree.path, ["branch", "--show-current"])).toBe(
          "brigadier/seed/slice-1\n",
        );
        expect(await gitText(worktree.path, ["rev-parse", "HEAD"])).toBe(
          `${session.baseCommit}\n`,
        );
        expect(
          await readFile(
            join(worktree.path, "node_modules/pkg/value.txt"),
            "utf8",
          ),
        ).toBe("dependency available\n");
        expect(await readFile(join(worktree.path, ".env"), "utf8")).toContain(
          SECRET,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not link secret files without separate explicit consent",
    async () => {
      await withFixture(async (fixture) => {
        const session = await fixture.engine.prepare({
          repositoryPath: fixture.repository,
          slug: "no-consent",
          dependencyPaths: ["node_modules"],
          secrets: { linkedPaths: [".env"] },
        });
        const worktree = await createWorktree(fixture, session, 1);

        await expect(stat(join(worktree.path, ".env"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "structurally refuses to commit a linked secret path",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "refusal",
        );
        const worktree = await createWorktree(fixture, session, 1);
        await gitText(worktree.path, ["add", "-f", ".env"]);

        const commitAttempt = fixture.engine.commit({
          worktree,
          message: "must refuse",
        });
        await expect(commitAttempt).rejects.toBeInstanceOf(
          LinkedSecretCommitError,
        );
        await expect(commitAttempt).rejects.toThrow(
          "refusing to commit linked secret path(s): .env",
        );
        expect(await gitText(worktree.path, ["rev-parse", "HEAD"])).toBe(
          `${session.baseCommit}\n`,
        );
        console.log(
          "commit-refusal guarantee: linked .env path rejected; branch unchanged",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "redacts a secret value from the commit message and diff hunk",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "redaction",
        );
        const worktree = await createWorktree(fixture, session, 1);
        await writeFile(
          join(worktree.path, "leak.txt"),
          `observed=${SECRET}\n`,
        );

        const result = await fixture.engine.commit({
          worktree,
          message: `worker reported ${SECRET}`,
        });
        const persistedCommit = await gitText(fixture.repository, [
          "show",
          "--format=fuller",
          "--patch",
          result.commit,
        ]);
        expect(persistedCommit).not.toContain(SECRET);
        expect(persistedCommit).toContain("worker reported [REDACTED]");
        expect(persistedCommit).toContain("+observed=[REDACTED]");
        expect(result.message).toBe("worker reported [REDACTED]");
        console.log(
          "redaction guarantee: secret absent from commit message and diff hunk",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "merges a slice commit into the integration branch without changing the user branch",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "merge",
        );
        const worktree = await createWorktree(fixture, session, 1);
        await writeFile(join(worktree.path, "slice.txt"), "slice result\n");
        const sliceCommit = await fixture.engine.commit({
          worktree,
          message: "slice complete",
        });

        const merged = await fixture.engine.merge({ worktree });
        expect(merged.status).toBe("merged");
        if (merged.status !== "merged") {
          throw new Error("expected a clean merge");
        }
        expect(
          await gitText(fixture.repository, [
            "rev-parse",
            session.integrationBranch,
          ]),
        ).toBe(`${merged.commit}\n`);
        expect(
          (
            await gitText(fixture.repository, [
              "show",
              "-s",
              "--format=%P",
              merged.commit,
            ])
          )
            .trim()
            .split(" "),
        ).toEqual([session.baseCommit, sliceCommit.commit]);
        expect(
          await gitText(fixture.repository, [
            "show",
            `${session.integrationBranch}:slice.txt`,
          ]),
        ).toBe("slice result\n");
        expect(
          await gitText(fixture.repository, ["branch", "--show-current"]),
        ).toBe("main\n");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reports merge conflicts and leaves the integration branch unchanged",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "conflict",
        );
        const first = await createWorktree(fixture, session, 1);
        const second = await createWorktree(fixture, session, 2);
        await writeFile(join(first.path, "tracked.txt"), "first slice\n");
        await writeFile(join(second.path, "tracked.txt"), "second slice\n");
        await fixture.engine.commit({ worktree: first, message: "first" });
        await fixture.engine.commit({ worktree: second, message: "second" });
        const firstMerge = await fixture.engine.merge({ worktree: first });
        expect(firstMerge.status).toBe("merged");
        const integrationBeforeConflict = await gitText(fixture.repository, [
          "rev-parse",
          session.integrationBranch,
        ]);

        const conflict = await fixture.engine.merge({ worktree: second });
        expect(conflict.status).toBe("conflicted");
        if (conflict.status !== "conflicted") {
          throw new Error("expected an explicit conflict result");
        }
        expect(conflict.details).toContain("tracked.txt");
        expect(
          await gitText(fixture.repository, [
            "rev-parse",
            session.integrationBranch,
          ]),
        ).toBe(integrationBeforeConflict);
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "supports unsafe in-place work without checking out or committing the user branch",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "unsafe",
        );
        const worktree = await fixture.engine.create({
          session,
          slice: 1,
          unsafeInPlace: true,
        });
        fixture.worktrees.push(worktree);
        await writeFile(
          join(fixture.repository, "unsafe.txt"),
          "unsafe result\n",
        );

        const result = await fixture.engine.commit({
          worktree,
          message: "unsafe slice",
        });
        expect(worktree.isolated).toBe(false);
        expect(
          await gitText(fixture.repository, ["branch", "--show-current"]),
        ).toBe("main\n");
        expect(
          await gitText(fixture.repository, [
            "diff",
            "--cached",
            "--name-only",
          ]),
        ).toBe("");
        expect(
          await gitText(fixture.repository, [
            "show",
            `${result.commit}:unsafe.txt`,
          ]),
        ).toBe("unsafe result\n");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "removes and unregisters an isolated worktree",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "remove",
        );
        const worktree = await createWorktree(fixture, session, 1);

        await fixture.engine.remove(worktree);
        fixture.worktrees.splice(fixture.worktrees.indexOf(worktree), 1);
        await expect(stat(worktree.path)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(
          await gitText(fixture.repository, [
            "worktree",
            "list",
            "--porcelain",
          ]),
        ).not.toContain(worktree.path);
      });
    },
    TEST_TIMEOUT_MS,
  );
});

async function withFixture(
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(scratchParent, ".worktree-test-"));
  const repository = join(root, "repository");
  const engine = new GitWorktreeEngine({ commandTimeoutMs: GIT_TIMEOUT_MS });
  const fixture: Fixture = { root, repository, engine, worktrees: [] };
  let testError: unknown;
  try {
    await initializeRepository(repository);
    await run(fixture);
  } catch (error) {
    testError = error;
  } finally {
    for (const worktree of fixture.worktrees.toReversed()) {
      try {
        await engine.remove(worktree);
      } catch (error) {
        testError ??= error;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
  if (testError !== undefined) {
    throw testError;
  }
}

async function initializeRepository(repository: string): Promise<void> {
  await mkdir(repository, { recursive: true });
  await gitText(repository, ["init", "--initial-branch=main"]);
  await gitText(repository, ["config", "user.name", "Brigadier Test"]);
  await gitText(repository, [
    "config",
    "user.email",
    "brigadier@example.invalid",
  ]);
  await writeFile(join(repository, ".gitignore"), "node_modules/\n.env\n");
  await writeFile(join(repository, "tracked.txt"), "tracked at head\n");
  await gitText(repository, ["add", ".gitignore", "tracked.txt"]);
  await gitText(repository, ["commit", "--quiet", "-m", "initial"]);

  await mkdir(join(repository, "node_modules/pkg"), { recursive: true });
  await writeFile(
    join(repository, "node_modules/pkg/value.txt"),
    "dependency available\n",
  );
  await writeFile(join(repository, ".env"), `API_TOKEN=${SECRET}\n`);
  await writeFile(join(repository, "tracked.txt"), "tracked in progress\n");
  await writeFile(join(repository, "untracked.txt"), "untracked in progress\n");
  await writeFile(
    join(repository, "base-leak.txt"),
    `base observed=${SECRET}\n`,
  );
}

async function prepare(
  engine: GitWorktreeEngine,
  repository: string,
  slug: string,
) {
  return await engine.prepare({
    repositoryPath: repository,
    slug,
    dependencyPaths: ["node_modules"],
    secrets: {
      linkedPaths: [".env"],
      consentToLink: true,
    },
  });
}

async function createWorktree(
  fixture: Fixture,
  session: Awaited<ReturnType<typeof prepare>>,
  slice: number,
): Promise<CreatedWorktree> {
  const worktree = await fixture.engine.create({
    session,
    slice,
    path: join(fixture.root, `slice-${slice}`),
  });
  fixture.worktrees.push(worktree);
  return worktree;
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      detached: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const kill = () => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // The process may already have exited.
        }
      }
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      kill();
      if (!settled) {
        settled = true;
        reject(new Error(`test git ${args[0] ?? "command"} timed out`));
      }
    }, GIT_TIMEOUT_MS);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `test git ${args[0] ?? "command"} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8")}`,
          ),
        );
        return;
      }
      resolvePromise(Buffer.concat(stdout).toString("utf8"));
    });
  });
}
