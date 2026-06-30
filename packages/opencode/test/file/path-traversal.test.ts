import { test, expect, describe } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { Filesystem } from "../../src/util"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { provideInstance, tmpdir, withTmpdirOutsideGit } from "../fixture/fixture"

const run = <A, E>(eff: Effect.Effect<A, E, File.Service>) =>
  Effect.runPromise(provideInstance(Instance.directory)(eff.pipe(Effect.provide(File.defaultLayer))))
const read = (file: string) => run(File.Service.use((svc) => svc.read(file)))
const list = (dir?: string) => run(File.Service.use((svc) => svc.list(dir)))

describe("Filesystem.contains", () => {
  test("allows paths within project", () => {
    expect(Filesystem.contains("/project", "/project/src")).toBe(true)
    expect(Filesystem.contains("/project", "/project/src/file.ts")).toBe(true)
    expect(Filesystem.contains("/project", "/project")).toBe(true)
  })

  test("blocks ../ traversal", () => {
    expect(Filesystem.contains("/project", "/project/../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/project/src/../../etc")).toBe(false)
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
  })

  test("blocks absolute paths outside project", () => {
    expect(Filesystem.contains("/project", "/etc/passwd")).toBe(false)
    expect(Filesystem.contains("/project", "/tmp/file")).toBe(false)
    expect(Filesystem.contains("/home/user/project", "/home/user/other")).toBe(false)
  })

  test("handles prefix collision edge cases", () => {
    expect(Filesystem.contains("/project", "/project-other/file")).toBe(false)
    expect(Filesystem.contains("/project", "/projectfile")).toBe(false)
  })
})

/*
 * Integration tests for read() and list() path traversal protection.
 *
 * These tests verify the HTTP API code path is protected. The HTTP endpoints
 * in server.ts (GET /file/content, GET /file) call read()/list()
 * directly - they do NOT go through ReadTool or the agent permission layer.
 *
 * This is a SEPARATE code path from ReadTool, which has its own checks.
 */
// These traversal tests need tmpdirs outside any git repo so project detection
// sets worktree="/" (the non-git sentinel). Otherwise containsPath falls through
// to the worktree check and allows paths within the parent repo.

describe("File.read path traversal protection", () => {
  test("rejects ../ traversal attempting to read /etc/passwd", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "allowed.txt"), "allowed content")
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("../../../etc/passwd")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    }))

  test("rejects deeply nested traversal", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(read("src/nested/../../../../../../../etc/passwd")).rejects.toThrow(
          "Access denied: path escapes project directory",
        )
      },
    })
  })

  test("allows valid paths within project", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "valid.txt"), "valid content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await read("valid.txt")
        expect(result.content).toBe("valid content")
      },
    })
  })
})

describe("File.list path traversal protection", () => {
  test("rejects ../ traversal attempting to list /etc", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(list("../../../etc")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    }))

  test("allows valid subdirectory listing", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "file.txt"), "content")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await list("subdir")
        expect(Array.isArray(result)).toBe(true)
      },
    })
  })
})

describe("Instance.containsPath", () => {
  test("returns true for path inside directory", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "foo.txt"))).toBe(true)
        expect(Instance.containsPath(path.join(tmp.path, "src", "file.ts"))).toBe(true)
      },
    })
  })

  test("returns true for path inside worktree but outside directory (monorepo subdirectory scenario)", async () => {
    await using tmp = await tmpdir({ git: true })
    const subdir = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(subdir, { recursive: true })

    await Instance.provide({
      directory: subdir,
      fn: () => {
        // .mimocode at worktree root, but we're running from packages/lib
        expect(Instance.containsPath(path.join(tmp.path, ".mimocode", "state"))).toBe(true)
        // sibling package should also be accessible
        expect(Instance.containsPath(path.join(tmp.path, "packages", "other", "file.ts"))).toBe(true)
        // worktree root itself
        expect(Instance.containsPath(tmp.path)).toBe(true)
      },
    })
  })

  test("returns false for path outside both directory and worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other-project")).toBe(false)
      },
    })
  })

  test("returns false for path with .. escaping worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.containsPath(path.join(tmp.path, "..", "escape.txt"))).toBe(false)
      },
    })
  })

  test("handles directory === worktree (running from repo root)", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        expect(Instance.directory).toBe(Instance.worktree)
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
      },
    })
  })

  test("non-git project does not allow arbitrary paths via worktree='/'", async () => {
    await using tmp = await tmpdir() // no git: true

    await Instance.provide({
      directory: tmp.path,
      fn: () => {
        // worktree is "/" for non-git projects, but containsPath should NOT allow all paths
        expect(Instance.containsPath(path.join(tmp.path, "file.txt"))).toBe(true)
        expect(Instance.containsPath("/etc/passwd")).toBe(false)
        expect(Instance.containsPath("/tmp/other")).toBe(false)
      },
    })
  })
})

describe("Instance.provide directory safety", () => {
  test("rejects system paths containing secrets", async () => {
    const systemPaths = ["/etc", "/etc/nginx", "/etc/shadow", "/proc", "/sys", "/dev", "/boot"]
    for (const dir of systemPaths) {
      await expect(
        Instance.provide({ directory: dir, fn: () => {} }),
      ).rejects.toThrow("Access denied")
    }
  })

  test("rejects filesystem root", async () => {
    await expect(
      Instance.provide({ directory: "/", fn: () => {} }),
    ).rejects.toThrow("Access denied")
  })

  test("allows valid project directory", async () => {
    await using tmp = await tmpdir({ git: true })
    await expect(
      Instance.provide({ directory: tmp.path, fn: () => Instance.directory }),
    ).resolves.toBe(tmp.path)
  })

  test("allows subdirectory of a valid project", async () => {
    await using tmp = await tmpdir({ git: true })
    const sub = path.join(tmp.path, "packages", "lib")
    await fs.mkdir(sub, { recursive: true })
    await expect(
      Instance.provide({ directory: sub, fn: () => Instance.directory }),
    ).resolves.toBe(sub)
  })
})

// S-1 symlink traversal: a symlink whose lexical path is INSIDE the project
// but whose real target is OUTSIDE must be rejected. Before the fix, contains()
// operated purely on strings via path.relative(), so it never followed the
// symlink and the read sailed past the boundary.
describe("File.read symlink traversal protection", () => {
  test("rejects an in-project symlink whose target escapes the project", async () => {
    await using tmp = await tmpdir({ git: true })

    // A secret file living OUTSIDE the project directory.
    const outsideDir = path.join(path.dirname(tmp.path), "mimocode-secret-target-" + Math.random().toString(36).slice(2))
    await fs.mkdir(outsideDir, { recursive: true })
    const secret = path.join(outsideDir, "secret.txt")
    await Bun.write(secret, "TOP SECRET CONTENT")

    try {
      // A symlink INSIDE the project pointing at the outside secret.
      const link = path.join(tmp.path, "escape-link")
      await fs.symlink(secret, link)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("escape-link")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test("rejects a symlink directory containing outside files", async () => {
    await using tmp = await tmpdir({ git: true })

    const outsideDir = path.join(path.dirname(tmp.path), "mimocode-secret-dir-" + Math.random().toString(36).slice(2))
    await fs.mkdir(outsideDir, { recursive: true })
    await Bun.write(path.join(outsideDir, "leaked.txt"), "leaked")

    try {
      const link = path.join(tmp.path, "escape-dir")
      await fs.symlink(outsideDir, link, "dir")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Listing the symlinked dir must also be refused.
          await expect(list("escape-dir")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test("still allows a legitimate symlink that resolves inside the project", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "real.txt"), "real content")
    // Symlink inside project pointing to another path inside the same project.
    await fs.symlink(path.join(tmp.path, "real.txt"), path.join(tmp.path, "ok-link"))

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = await read("ok-link")
        expect(result.content).toBe("real content")
      },
    })
  })

  test("rejects a chained symlink (A -> B -> outside)", async () => {
    await using tmp = await tmpdir({ git: true })

    const outsideDir = path.join(path.dirname(tmp.path), "mimocode-chain-" + Math.random().toString(36).slice(2))
    await fs.mkdir(outsideDir, { recursive: true })
    const secret = path.join(outsideDir, "secret.txt")
    await Bun.write(secret, "CHAIN SECRET")

    try {
      // link2 points directly at the outside secret; link1 points at link2.
      const link2 = path.join(tmp.path, "l2")
      const link1 = path.join(tmp.path, "l1")
      await fs.symlink(secret, link2)
      await fs.symlink(link2, link1)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("l1")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  test("rejects a relative symlink that escapes the project", async () => {
    await using tmp = await tmpdir({ git: true })

    const outsideDir = path.join(path.dirname(tmp.path), "mimocode-rel-" + Math.random().toString(36).slice(2))
    await fs.mkdir(outsideDir, { recursive: true })
    const secret = path.join(outsideDir, "secret.txt")
    await Bun.write(secret, "REL SECRET")

    try {
      // Relative target: from tmp.path, "../<outsideDir-name>/secret.txt".
      const relTarget = path.join("..", path.basename(outsideDir), "secret.txt")
      await fs.symlink(relTarget, path.join(tmp.path, "rel-link"))

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await expect(read("rel-link")).rejects.toThrow("Access denied: path escapes project directory")
        },
      })
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })

  // Non-git projects set worktree="/" (the sentinel that would match any path).
  // This is exactly the configuration the original bug lived in: the guard at
  // containsPath must still reject a symlink that escapes the project directory.
  test("non-git project: rejects a symlink whose target escapes the directory", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir() // no git -> worktree === "/"

      const outsideDir = path.join(path.dirname(tmp.path), "mimocode-ng-" + Math.random().toString(36).slice(2))
      await fs.mkdir(outsideDir, { recursive: true })
      const secret = path.join(outsideDir, "secret.txt")
      await Bun.write(secret, "NON-GIT SECRET")

      try {
        await fs.symlink(secret, path.join(tmp.path, "escape-link"))

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            await expect(read("escape-link")).rejects.toThrow("Access denied: path escapes project directory")
          },
        })
      } finally {
        await fs.rm(outsideDir, { recursive: true, force: true })
      }
    }))

  test("broken symlink (target does not exist) does not crash read", () =>
    withTmpdirOutsideGit(async () => {
      await using tmp = await tmpdir() // no git
      // A symlink to a non-existent target inside the project. realpathSync
      // throws ENOENT; resolve falls back to the lexical path, which is inside
      // the project, so the check passes. read() then finds nothing and returns
      // empty content — it must NOT throw an unhandled ELOOP/ENOENT.
      await fs.symlink(path.join(tmp.path, "nope"), path.join(tmp.path, "broken-link"))

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const result = await read("broken-link")
          expect(result.content).toBe("")
        },
      })
    }))
})
