import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
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
const ROTATED_JSON_SECRET = "rotated-json-secret-value";
const ROTATED_YAML_SECRET = "rotated-yaml-secret-value";
const MULTILINE_SECRET = "multiline-secret-first\nmultiline-secret-second";
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
    "never writes secret bytes or filenames to reachable or unreachable Git objects",
    async () => {
      await withFixture(async ({ repository, engine }) => {
        const session = await prepare(engine, repository, "object-scan");
        const treePaths = await gitText(repository, [
          "ls-tree",
          "-r",
          "--name-only",
          session.baseCommit,
        ]);
        expect(treePaths).not.toContain(SECRET);
        expect(treePaths).toContain("artifact-[REDACTED].txt");

        const scan = await scanAllGitObjects(repository, SECRET);
        expect(scan.secretObjectIds).toEqual([]);
        console.log(
          `object-database scan: ${scan.objectCount} total objects (${scan.reachableCount} reachable, ${scan.unreachableCount} unreachable); secret absent from every object`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses a repository that declares a Git LFS clean filter",
    async () => {
      await withFixture(async ({ repository, engine }) => {
        await writeFile(
          join(repository, ".gitattributes"),
          "*.bin filter=lfs diff=lfs merge=lfs -text\n",
        );
        await writeFile(join(repository, "payload.bin"), SECRET);
        const message =
          "Git LFS is unsupported: remove filter=lfs attributes and unset filter.lfs.clean before using Brigadier";

        await expect(
          engine.prepare({
            repositoryPath: repository,
            slug: "lfs-refusal",
            secrets: { linkedPaths: [".env"] },
          }),
        ).rejects.toThrow(message);
        console.log(`LFS refusal: ${message}`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses a configured Git LFS clean filter",
    async () => {
      await withFixture(async ({ repository, engine }) => {
        await gitText(repository, [
          "config",
          "filter.lfs.clean",
          "git-lfs clean -- %f",
        ]);

        await expect(
          engine.prepare({
            repositoryPath: repository,
            slug: "lfs-config-refusal",
            secrets: { linkedPaths: [".env"] },
          }),
        ).rejects.toThrow(
          "Git LFS is unsupported: remove filter=lfs attributes and unset filter.lfs.clean before using Brigadier",
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
    "rejects nested dependency paths that bypass linked-secret consent",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "config"), { recursive: true });
        await writeFile(join(fixture.repository, "config/.env"), `${SECRET}\n`);

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "nested-consent",
            dependencyPaths: ["config"],
            secrets: { linkedPaths: ["config/.env"] },
          }),
        ).rejects.toThrow("config ↔ config/.env");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects dependency and linked-secret containment after symlink resolution",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "secret-config"), {
          recursive: true,
        });
        await writeFile(
          join(fixture.repository, "secret-config/token"),
          `${SECRET}\n`,
        );
        await symlink("secret-config", join(fixture.repository, "dependency"));

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "symlink-consent",
            dependencyPaths: ["dependency"],
            secrets: { linkedPaths: ["secret-config/token"] },
          }),
        ).rejects.toThrow("dependency ↔ secret-config/token");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a descendant symlink from a seeded dependency to a linked secret",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "deps"));
        await mkdir(join(fixture.repository, "secrets"));
        await writeFile(
          join(fixture.repository, "secrets/.env"),
          `${SECRET}\n`,
        );
        await symlink(
          "../secrets/.env",
          join(fixture.repository, "deps/token"),
        );

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "descendant-symlink",
            dependencyPaths: ["deps"],
            secrets: { linkedPaths: ["secrets/.env"] },
          }),
        ).rejects.toThrow("deps descendant deps/token ↔ secrets/.env");
        console.log(
          "descendant-symlink refusal: deps/token -> secrets/.env rejected with consentToLink=false",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "revalidates descendant symlinks added after prepare before create",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "deps"));
        await mkdir(join(fixture.repository, "secrets"));
        await writeFile(
          join(fixture.repository, "secrets/.env"),
          `${SECRET}\n`,
        );
        const session = await fixture.engine.prepare({
          repositoryPath: fixture.repository,
          slug: "late-descendant-symlink",
          dependencyPaths: ["deps"],
          secrets: { linkedPaths: ["secrets/.env"] },
        });
        await symlink(
          "../secrets/.env",
          join(fixture.repository, "deps/token"),
        );

        await expect(
          fixture.engine.create({
            session,
            slice: 1,
            path: join(fixture.root, "late-symlink-slice"),
          }),
        ).rejects.toThrow("deps descendant deps/token ↔ secrets/.env");
        console.log(
          "post-prepare descendant-symlink refusal: deps/token -> secrets/.env rejected before create seed",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a linked-secret symlink nested two levels inside a dependency",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "deps/one/two"), {
          recursive: true,
        });
        await mkdir(join(fixture.repository, "secrets"));
        await writeFile(
          join(fixture.repository, "secrets/.env"),
          `${SECRET}\n`,
        );
        await symlink(
          "../../../secrets/.env",
          join(fixture.repository, "deps/one/two/token"),
        );

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "deep-descendant-symlink",
            dependencyPaths: ["deps"],
            secrets: { linkedPaths: ["secrets/.env"] },
          }),
        ).rejects.toThrow("deps descendant deps/one/two/token ↔ secrets/.env");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects a descendant dependency symlink that escapes the repository",
    async () => {
      await withFixture(async (fixture) => {
        const outside = join(fixture.root, "outside");
        await mkdir(join(fixture.repository, "deps"));
        await mkdir(outside);
        await writeFile(join(outside, "token"), `${SECRET}\n`);
        await symlink(outside, join(fixture.repository, "deps/outside"));

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "external-dependency-symlink",
            dependencyPaths: ["deps"],
            secrets: { linkedPaths: [".env"] },
          }),
        ).rejects.toThrow(
          "dependency symlink escapes repository: deps/outside",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects symlink loops while walking a seeded dependency",
    async () => {
      await withFixture(async (fixture) => {
        await mkdir(join(fixture.repository, "deps"));
        await symlink("second", join(fixture.repository, "deps/first"));
        await symlink("first", join(fixture.repository, "deps/second"));

        await expect(
          fixture.engine.prepare({
            repositoryPath: fixture.repository,
            slug: "dependency-symlink-loop",
            dependencyPaths: ["deps"],
            secrets: { linkedPaths: [".env"] },
          }),
        ).rejects.toThrow("dependency symlink loop at deps/");
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
    "captures an advanced submodule pointer in the scratch base commit",
    async () => {
      await withFixture(async (fixture) => {
        const submoduleSource = join(fixture.root, "submodule-source");
        await mkdir(submoduleSource);
        await gitText(submoduleSource, ["init", "--initial-branch=main"]);
        await gitText(submoduleSource, [
          "config",
          "user.name",
          "Brigadier Test",
        ]);
        await gitText(submoduleSource, [
          "config",
          "user.email",
          "brigadier@example.invalid",
        ]);
        await writeFile(join(submoduleSource, "value.txt"), "first\n");
        await gitText(submoduleSource, ["add", "value.txt"]);
        await gitText(submoduleSource, ["commit", "--quiet", "-m", "first"]);

        await gitText(fixture.repository, [
          "-c",
          "protocol.file.allow=always",
          "submodule",
          "add",
          "--quiet",
          submoduleSource,
          "vendor/submodule",
        ]);
        await gitText(fixture.repository, [
          "commit",
          "--quiet",
          "-m",
          "add submodule",
          "--",
          ".gitmodules",
          "vendor/submodule",
        ]);

        const checkout = join(fixture.repository, "vendor/submodule");
        await gitText(checkout, ["config", "user.name", "Brigadier Test"]);
        await gitText(checkout, [
          "config",
          "user.email",
          "brigadier@example.invalid",
        ]);
        await writeFile(join(checkout, "value.txt"), "advanced\n");
        await gitText(checkout, ["add", "value.txt"]);
        await gitText(checkout, ["commit", "--quiet", "-m", "advanced"]);
        const advancedHead = (
          await gitText(checkout, ["rev-parse", "HEAD"])
        ).trim();

        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "submodule-pointer",
        );
        const entry = await gitText(fixture.repository, [
          "ls-tree",
          session.baseCommit,
          "vendor/submodule",
        ]);
        expect(entry).toBe(`160000 commit ${advancedHead}\tvendor/submodule\n`);
        console.log(
          `submodule capture: base commit records advanced gitlink ${advancedHead}`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "matches plain git add clean-filter and EOL normalization output",
    async () => {
      await withFixture(async (fixture) => {
        await gitText(fixture.repository, [
          "config",
          "filter.canonical.clean",
          "sed s/WORKTREE/FILTERED/g",
        ]);
        await gitText(fixture.repository, [
          "config",
          "filter.canonical.smudge",
          "cat",
        ]);
        await gitText(fixture.repository, [
          "config",
          "filter.canonical.required",
          "true",
        ]);
        await writeFile(
          join(fixture.repository, ".gitattributes"),
          "filtered.txt filter=canonical text eol=lf\n",
        );
        await writeFile(
          join(fixture.repository, "filtered.txt"),
          "WORKTREE first\r\nWORKTREE second\r\n",
        );

        await gitText(fixture.repository, [
          "add",
          ".gitattributes",
          "filtered.txt",
        ]);
        const plainEntry = await gitText(fixture.repository, [
          "ls-files",
          "--stage",
          "--",
          "filtered.txt",
        ]);
        const expectedObjectId = plainEntry.split(" ")[1];
        if (expectedObjectId === undefined) {
          throw new Error("plain git add did not stage filtered.txt");
        }
        await gitText(fixture.repository, ["reset", "--mixed", "--quiet"]);

        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "filter-eol",
        );
        const actualObjectId = (
          await gitText(fixture.repository, [
            "rev-parse",
            `${session.baseCommit}:filtered.txt`,
          ])
        ).trim();
        expect(actualObjectId).toBe(expectedObjectId);
        expect(
          await gitText(fixture.repository, [
            "cat-file",
            "blob",
            actualObjectId,
          ]),
        ).toBe("FILTERED first\nFILTERED second\n");
        console.log(
          `filter/EOL equivalence: brigadier blob matches plain git add blob ${actualObjectId}; normalized LF bytes preserved`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "respects core.fileMode=false when capturing executable modes",
    async () => {
      await withFixture(async (fixture) => {
        const script = join(fixture.repository, "script.sh");
        await writeFile(script, "#!/bin/sh\nexit 0\n");
        await chmod(script, 0o755);
        await gitText(fixture.repository, ["add", "script.sh"]);
        await gitText(fixture.repository, [
          "commit",
          "--quiet",
          "-m",
          "add executable",
          "--",
          "script.sh",
        ]);
        await gitText(fixture.repository, ["config", "core.fileMode", "false"]);
        await chmod(script, 0o644);

        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "file-mode",
        );
        const entry = await gitText(fixture.repository, [
          "ls-tree",
          session.baseCommit,
          "script.sh",
        ]);
        expect(entry).toStartWith("100755 blob ");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "re-reads JSON and YAML secret values, including multiline values, before each commit",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "rotated-redaction",
        );
        const worktree = await createWorktree(fixture, session, 1);

        await writeFile(
          join(fixture.repository, ".env"),
          `${JSON.stringify({ token: ROTATED_JSON_SECRET })}\n`,
        );
        await writeFile(
          join(worktree.path, "json-leak.txt"),
          `${SECRET}\n${ROTATED_JSON_SECRET}\n`,
        );
        const jsonCommit = await fixture.engine.commit({
          worktree,
          message: ROTATED_JSON_SECRET,
        });
        const persistedJson = await gitText(fixture.repository, [
          "show",
          "--format=fuller",
          "--patch",
          jsonCommit.commit,
        ]);
        expect(persistedJson).not.toContain(SECRET);
        expect(persistedJson).not.toContain(ROTATED_JSON_SECRET);

        await writeFile(
          join(fixture.repository, ".env"),
          `token: ${ROTATED_YAML_SECRET}\ncertificate: |\n  ${MULTILINE_SECRET.replace("\n", "\n  ")}\n`,
        );
        await writeFile(
          join(worktree.path, "yaml-leak.txt"),
          `${ROTATED_YAML_SECRET}\n${MULTILINE_SECRET}\n`,
        );
        const yamlCommit = await fixture.engine.commit({
          worktree,
          message: `${ROTATED_YAML_SECRET}\n${MULTILINE_SECRET}`,
        });
        const persisted = await gitText(fixture.repository, [
          "show",
          "--format=fuller",
          "--patch",
          yamlCommit.commit,
        ]);
        expect(persisted).not.toContain(ROTATED_YAML_SECRET);
        for (const line of MULTILINE_SECRET.split("\n")) {
          expect(persisted).not.toContain(line);
        }
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
    "branches a later wave from accumulated earlier-wave content and releases every scratch ref",
    async () => {
      await withFixture(async (fixture) => {
        const originalHead = await gitBuffer(fixture.repository, [
          "rev-parse",
          "HEAD",
        ]);
        expect(
          await gitBuffer(fixture.repository, ["symbolic-ref", "HEAD"]),
        ).toEqual(Buffer.from("refs/heads/main\n"));
        expect(
          await gitBuffer(fixture.repository, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]),
        ).toEqual(
          Buffer.from(
            " M tracked.txt\n" +
              `?? artifact-${SECRET}.txt\n` +
              "?? base-leak.txt\n" +
              "?? untracked.txt\n",
          ),
        );

        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "two-waves",
        );
        const producer = await createWorktree(fixture, session, 1);
        await writeFile(
          join(producer.path, "helper.ts"),
          'export const helper = "wave-one-output";\n',
        );
        await fixture.engine.commit({
          worktree: producer,
          message: "produce helper",
        });
        const accumulated = await fixture.engine.merge({
          worktree: producer,
          message: "accumulate wave 1",
          finalize: false,
        });
        expect(accumulated.status).toBe("merged");
        if (accumulated.status !== "merged") {
          throw new Error("expected wave 1 to accumulate cleanly");
        }

        const consumer = await createWorktree(fixture, session, 2);
        const helperBytes = await readFile(join(consumer.path, "helper.ts"));
        expect(helperBytes).toEqual(
          Buffer.from('export const helper = "wave-one-output";\n'),
        );
        expect(await gitBuffer(consumer.path, ["rev-parse", "HEAD"])).toEqual(
          Buffer.from(`${accumulated.commit}\n`),
        );

        await fixture.engine.remove(producer);
        fixture.worktrees.splice(fixture.worktrees.indexOf(producer), 1);
        await fixture.engine.remove(consumer);
        fixture.worktrees.splice(fixture.worktrees.indexOf(consumer), 1);
        await fixture.engine.release(session);
        expect(
          await gitText(fixture.repository, [
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads/brigadier/",
          ]),
        ).toBe("");
        expect(
          await gitBuffer(fixture.repository, ["branch", "--show-current"]),
        ).toEqual(Buffer.from("main\n"));
        expect(
          await gitBuffer(fixture.repository, ["symbolic-ref", "HEAD"]),
        ).toEqual(Buffer.from("refs/heads/main\n"));
        expect(
          await gitBuffer(fixture.repository, ["rev-parse", "HEAD"]),
        ).toEqual(originalHead);
        expect(await readFile(join(fixture.repository, "tracked.txt"))).toEqual(
          Buffer.from("tracked in progress\n"),
        );
        expect(
          await readFile(join(fixture.repository, "untracked.txt")),
        ).toEqual(Buffer.from("untracked in progress\n"));
        expect(
          await gitBuffer(fixture.repository, [
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ]),
        ).toEqual(
          Buffer.from(
            " M tracked.txt\n" +
              `?? artifact-${SECRET}.txt\n` +
              "?? base-leak.txt\n" +
              "?? untracked.txt\n",
          ),
        );

        console.log(
          `two-wave proof: wave 2 helper.ts bytes = ${JSON.stringify(helperBytes.toString("utf8"))}`,
        );
        console.log(
          'two-wave proof: user HEAD = "refs/heads/main\\n"; source tracked.txt bytes = "tracked in progress\\n"; refs/heads/brigadier/** after release = ""',
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "materializes the accumulated head before final reconciliation",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "finalize-waves",
        );
        const producer = await createWorktree(fixture, session, 1);
        await writeFile(join(producer.path, "helper.ts"), "wave 1 helper\n");
        await fixture.engine.commit({
          worktree: producer,
          message: "produce wave 1 helper",
        });
        const accumulated = await fixture.engine.merge({
          worktree: producer,
          message: "accumulate wave 1",
          finalize: false,
        });
        expect(accumulated.status).toBe("merged");
        if (accumulated.status !== "merged") {
          throw new Error("expected wave 1 to accumulate cleanly");
        }

        const consumer = await createWorktree(fixture, session, 2);
        await writeFile(
          join(consumer.path, "consumer.ts"),
          "wave 2 consumer\n",
        );
        const consumerCommit = await fixture.engine.commit({
          worktree: consumer,
          message: "consume wave 1 helper",
        });

        const producerFinal = await fixture.engine.merge({
          worktree: producer,
        });
        expect(producerFinal).toEqual({
          status: "already-integrated",
          commit: accumulated.commit,
          integrationBranch: "brigadier/finalize-waves",
        });
        const consumerFinal = await fixture.engine.merge({
          worktree: consumer,
        });
        expect(consumerFinal.status).toBe("merged");
        if (consumerFinal.status !== "merged") {
          throw new Error("expected wave 2 to merge cleanly");
        }
        expect(
          await gitText(fixture.repository, [
            "show",
            "brigadier/finalize-waves:helper.ts",
          ]),
        ).toBe("wave 1 helper\n");
        expect(
          await gitText(fixture.repository, [
            "show",
            "brigadier/finalize-waves:consumer.ts",
          ]),
        ).toBe("wave 2 consumer\n");
        expect(
          await gitText(fixture.repository, [
            "show",
            "-s",
            "--format=%P",
            consumerFinal.commit,
          ]),
        ).toBe(`${accumulated.commit} ${consumerCommit.commit}\n`);
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "leaves the accumulated base unchanged after a scratch merge conflict",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "wave-conflict",
        );
        const accepted = await createWorktree(fixture, session, 1);
        const rejected = await createWorktree(fixture, session, 2);
        await writeFile(join(accepted.path, "tracked.txt"), "accepted wave\n");
        await writeFile(join(rejected.path, "tracked.txt"), "rejected wave\n");
        await fixture.engine.commit({
          worktree: accepted,
          message: "accepted slice",
        });
        await fixture.engine.commit({
          worktree: rejected,
          message: "conflicting slice",
        });

        const accumulated = await fixture.engine.merge({
          worktree: accepted,
          finalize: false,
        });
        expect(accumulated.status).toBe("merged");
        if (accumulated.status !== "merged") {
          throw new Error("expected the first scratch merge to succeed");
        }
        const conflict = await fixture.engine.merge({
          worktree: rejected,
          finalize: false,
        });
        expect(conflict.status).toBe("conflicted");
        expect(
          await gitText(fixture.repository, ["rev-parse", session.baseBranch]),
        ).toBe(`${accumulated.commit}\n`);

        const laterWave = await createWorktree(fixture, session, 3);
        expect(
          await readFile(join(laterWave.path, "tracked.txt"), "utf8"),
        ).toBe("accepted wave\n");
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
        if (firstMerge.status !== "merged") {
          throw new Error("expected the first slice to merge cleanly");
        }
        const integrationRef = `refs/heads/${session.integrationBranch}`;
        expect(integrationRef).toBe("refs/heads/brigadier/conflict");
        const integrationBeforeConflict = await gitBuffer(fixture.repository, [
          "show-ref",
          "--verify",
          "--hash",
          integrationRef,
        ]);
        expect(integrationBeforeConflict).toEqual(
          Buffer.from(`${firstMerge.commit}\n`),
        );

        const conflict = await fixture.engine.merge({ worktree: second });
        expect(conflict.status).toBe("conflicted");
        if (conflict.status !== "conflicted") {
          throw new Error("expected an explicit conflict result");
        }
        expect(conflict.details).toContain("tracked.txt");
        expect(
          await gitBuffer(fixture.repository, [
            "show-ref",
            "--verify",
            "--hash",
            integrationRef,
          ]),
        ).toEqual(integrationBeforeConflict);
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/brigadier/conflict ${firstMerge.commit}\n` +
            `refs/heads/main ${(await gitText(fixture.repository, ["rev-parse", "main"])).trim()}\n`,
        );
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

  test(
    "releases every all-failed ref idempotently and permits the same slug again",
    async () => {
      await withFixture(async (fixture) => {
        const originalHead = await gitBuffer(fixture.repository, [
          "rev-parse",
          "HEAD",
        ]);
        const originalHeadRef = await gitBuffer(fixture.repository, [
          "symbolic-ref",
          "HEAD",
        ]);
        const originalMainRef = await gitBuffer(fixture.repository, [
          "show-ref",
          "--verify",
          "--hash",
          "refs/heads/main",
        ]);
        const originalCommit = originalHead.toString("utf8").trim();
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "all-failed",
        );
        const first = await createWorktree(fixture, session, 1);
        const second = await createWorktree(fixture, session, 2);

        await fixture.engine.remove(first);
        fixture.worktrees.splice(fixture.worktrees.indexOf(first), 1);
        await fixture.engine.remove(second);
        fixture.worktrees.splice(fixture.worktrees.indexOf(second), 1);
        // A prior cleanup may already have removed one engine-owned ref.
        await gitText(fixture.repository, [
          "update-ref",
          "-d",
          "refs/heads/brigadier/all-failed/slice-2",
          session.baseCommit,
        ]);

        await fixture.engine.release(session);
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/main ${originalCommit}\n`,
        );
        expect(
          await gitBuffer(fixture.repository, ["rev-parse", "HEAD"]),
        ).toEqual(originalHead);
        expect(
          await gitBuffer(fixture.repository, ["symbolic-ref", "HEAD"]),
        ).toEqual(originalHeadRef);
        expect(
          await gitBuffer(fixture.repository, [
            "show-ref",
            "--verify",
            "--hash",
            "refs/heads/main",
          ]),
        ).toEqual(originalMainRef);

        await fixture.engine.release(session);
        // Released sessions are tombstoned instead of silently recreating refs.
        await expect(
          fixture.engine.create({
            session,
            slice: 3,
            path: join(fixture.root, "released-slice-3"),
          }),
        ).rejects.toThrow("worktree session refs have already been released");

        const retried = await prepare(
          fixture.engine,
          fixture.repository,
          "all-failed",
        );
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/brigadier/all-failed/base ${retried.baseCommit}\n` +
            `refs/heads/main ${originalCommit}\n`,
        );
        await fixture.engine.release(retried);
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/main ${originalCommit}\n`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to release a session while an engine-created worktree is active",
    async () => {
      await withFixture(async (fixture) => {
        const originalHead = (
          await gitText(fixture.repository, ["rev-parse", "HEAD"])
        ).trim();
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "active-release",
        );
        await createWorktree(fixture, session, 1);

        await expect(fixture.engine.release(session)).rejects.toThrow(
          "cannot release worktree session active-release: 1 worktree(s) are still active",
        );
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/brigadier/active-release/base ${session.baseCommit}\n` +
            `refs/heads/brigadier/active-release/slice-1 ${session.baseCommit}\n` +
            `refs/heads/main ${originalHead}\n`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "rejects foreign sessions and moved refs without partially releasing",
    async () => {
      await withFixture(async (fixture) => {
        const originalHead = (
          await gitText(fixture.repository, ["rev-parse", "HEAD"])
        ).trim();
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "release-guards",
        );
        const worktree = await createWorktree(fixture, session, 1);
        await fixture.engine.remove(worktree);
        fixture.worktrees.splice(fixture.worktrees.indexOf(worktree), 1);

        const foreignEngine = new GitWorktreeEngine({
          commandTimeoutMs: GIT_TIMEOUT_MS,
        });
        await expect(foreignEngine.release(session)).rejects.toThrow(
          "worktree session was not prepared by this engine",
        );

        await gitText(fixture.repository, [
          "update-ref",
          "refs/heads/brigadier/release-guards/slice-1",
          originalHead,
          session.baseCommit,
        ]);
        await expect(fixture.engine.release(session)).rejects.toThrow(
          "engine-created ref refs/heads/brigadier/release-guards/slice-1 moved unexpectedly",
        );
        expect(await headRefListing(fixture.repository)).toBe(
          `refs/heads/brigadier/release-guards/base ${session.baseCommit}\n` +
            `refs/heads/brigadier/release-guards/slice-1 ${originalHead}\n` +
            `refs/heads/main ${originalHead}\n`,
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "keeps a materialized integration branch unchanged when release is called",
    async () => {
      await withFixture(async (fixture) => {
        const originalHead = (
          await gitText(fixture.repository, ["rev-parse", "HEAD"])
        ).trim();
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "release-merged",
        );
        const worktree = await createWorktree(fixture, session, 1);
        await writeFile(
          join(worktree.path, "merged-output.txt"),
          "merged output\n",
        );
        const slice = await fixture.engine.commit({
          worktree,
          message: "completed slice",
        });
        const merged = await fixture.engine.merge({ worktree });
        expect(merged.status).toBe("merged");
        if (merged.status !== "merged") {
          throw new Error("expected a clean merge");
        }
        expect(
          await gitText(fixture.repository, [
            "show",
            "-s",
            "--format=%P",
            merged.commit,
          ]),
        ).toBe(`${session.baseCommit} ${slice.commit}\n`);

        await fixture.engine.remove(worktree);
        fixture.worktrees.splice(fixture.worktrees.indexOf(worktree), 1);
        const refsBeforeRelease =
          `refs/heads/brigadier/release-merged ${merged.commit}\n` +
          `refs/heads/main ${originalHead}\n`;
        expect(await headRefListing(fixture.repository)).toBe(
          refsBeforeRelease,
        );
        await fixture.engine.release(session);
        await fixture.engine.release(session);
        expect(await headRefListing(fixture.repository)).toBe(
          refsBeforeRelease,
        );
        expect(
          await gitText(fixture.repository, ["cat-file", "-t", merged.commit]),
        ).toBe("commit\n");
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preserves a pre-existing non-empty directory when worktree creation fails",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "safe-cleanup",
        );
        const occupied = join(fixture.root, "occupied");
        const sentinel = join(occupied, "keep-me.txt");
        await mkdir(occupied);
        await writeFile(sentinel, "intact\n");

        await expect(
          fixture.engine.create({ session, slice: 1, path: occupied }),
        ).rejects.toThrow("already exists and is not an empty directory");
        expect(await readFile(sentinel, "utf8")).toBe("intact\n");
        expect(
          await gitText(fixture.repository, [
            "branch",
            "--list",
            "brigadier/safe-cleanup/slice-1",
          ]),
        ).toBe("");
        console.log(
          "destructive-cleanup scan: pre-existing directory intact; sentinel content intact; slice ref absent",
        );
      });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "does not leak a slice ref when the isolated worktree path is invalid",
    async () => {
      await withFixture(async (fixture) => {
        const session = await prepare(
          fixture.engine,
          fixture.repository,
          "invalid-path",
        );
        await expect(
          fixture.engine.create({
            session,
            slice: 1,
            path: join(fixture.repository, "nested"),
          }),
        ).rejects.toThrow("must be outside the source repository");
        expect(
          await gitText(fixture.repository, [
            "branch",
            "--list",
            "brigadier/invalid-path/slice-1",
          ]),
        ).toBe("");
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
  await writeFile(join(repository, ".env"), `${SECRET}\n`);
  await writeFile(join(repository, "tracked.txt"), "tracked in progress\n");
  await writeFile(join(repository, "untracked.txt"), "untracked in progress\n");
  await writeFile(
    join(repository, `artifact-${SECRET}.txt`),
    "secret appeared only in this filename\n",
  );
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

async function scanAllGitObjects(
  repository: string,
  secret: string,
): Promise<{
  readonly objectCount: number;
  readonly reachableCount: number;
  readonly unreachableCount: number;
  readonly secretObjectIds: readonly string[];
}> {
  const reachable = new Set(
    (await gitText(repository, ["rev-list", "--objects", "--all"]))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ", 1)[0] ?? ""),
  );
  await gitText(repository, [
    "fsck",
    "--no-reflogs",
    "--unreachable",
    "--no-progress",
  ]);
  const records = (
    await gitText(repository, [
      "cat-file",
      "--batch-all-objects",
      "--batch-check=%(objectname) %(objecttype)",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [objectId = "", type = ""] = line.split(" ");
      return { objectId, type };
    });
  const secretBytes = Buffer.from(secret);
  const secretObjectIds: string[] = [];
  for (const { objectId, type } of records) {
    const contents = await gitBuffer(repository, ["cat-file", type, objectId]);
    if (contents.includes(secretBytes)) {
      secretObjectIds.push(objectId);
    }
  }
  return {
    objectCount: records.length,
    reachableCount: records.filter(({ objectId }) => reachable.has(objectId))
      .length,
    unreachableCount: records.filter(({ objectId }) => !reachable.has(objectId))
      .length,
    secretObjectIds,
  };
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  return (await gitBuffer(cwd, args)).toString("utf8");
}

async function headRefListing(repository: string): Promise<string> {
  return await gitText(repository, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname) %(objectname)",
    "refs/heads/",
  ]);
}

async function gitBuffer(
  cwd: string,
  args: readonly string[],
): Promise<Buffer> {
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
      resolvePromise(Buffer.concat(stdout));
    });
  });
}
