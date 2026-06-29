import { describe, test, expect, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import * as NFS from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Filesystem } from "../../src/util"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"

const runShared = <A, E>(eff: Effect.Effect<A, E, AppFileSystem.Service>) =>
  Effect.runPromise(Effect.provide(AppFileSystem.defaultLayer)(eff))

describe("atomic writes (S-3)", () => {
  test("util write() goes through an atomic temp+rename (no in-place truncation)", async () => {
    // The guarantee of atomicity: a write must NEVER leave the target file
    // half-written. We verify the mechanism by spying on fs.rename — an atomic
    // write swaps the target via rename; a non-atomic write never calls it.
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    const original = "ORIGINAL\n"
    await fs.writeFile(filepath, original, "utf-8")

    const renameSpy = spyOn(NFS, "rename")

    await Filesystem.write(filepath, "NEW FULL CONTENT\n")

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [from, to] = renameSpy.mock.calls[0]
    expect(to).toBe(filepath)
    expect(from).not.toBe(filepath) // wrote to a temp path, then renamed

    // Final content is the new one, fully.
    expect(await fs.readFile(filepath, "utf-8")).toBe("NEW FULL CONTENT\n")

    renameSpy.mockRestore()
  })

  test("shared writeWithDirs() writes atomically via rename", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "auth.json")
    const original = JSON.stringify({ key: "old" })
    await fs.writeFile(filepath, original, "utf-8")

    const renameSpy = spyOn(NFS, "rename")

    await runShared(AppFileSystem.Service.use((svc) => svc.writeWithDirs(filepath, '{"key":"new"}')))

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const [from, to] = renameSpy.mock.calls[0]
    expect(to).toBe(filepath)
    expect(from).not.toBe(filepath)

    expect(await fs.readFile(filepath, "utf-8")).toBe('{"key":"new"}')

    renameSpy.mockRestore()
  })

  test("shared writeJson() writes atomically via rename", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "data.json")
    const renameSpy = spyOn(NFS, "rename")

    await runShared(AppFileSystem.Service.use((svc) => svc.writeJson(filepath, { a: 1 })))

    expect(renameSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(await fs.readFile(filepath, "utf-8"))
    expect(parsed).toEqual({ a: 1 })

    renameSpy.mockRestore()
  })

  test("no leftover temp files after a successful atomic write", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "clean.txt")
    await Filesystem.write(filepath, "payload")

    const entries = await fs.readdir(tmp.path)
    const leftovers = entries.filter((e) => e.includes(".tmp"))
    expect(leftovers).toEqual([])
  })

  test("atomic write creates parent directories", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "nested", "deep", "file.txt")
    await Filesystem.write(filepath, "nested content")
    expect(await fs.readFile(filepath, "utf-8")).toBe("nested content")
  })

  test("atomic write preserves mode when specified", async () => {
    if (process.platform === "win32") return // chmod modes are a no-op on Windows
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "secret.txt")
    await Filesystem.write(filepath, "secret", 0o600)
    const stats = await fs.stat(filepath)
    expect(stats.mode & 0o777).toBe(0o600)
  })

  test("if rename fails, the target keeps its prior content (atomicity under failure)", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    const original = "ORIGINAL MUST SURVIVE A FAILED RENAME\n"
    await fs.writeFile(filepath, original, "utf-8")

    const renameSpy = spyOn(NFS, "rename").mockRejectedValue(new Error("simulated rename failure (EXDEV)"))

    await expect(Filesystem.write(filepath, "NEW CONTENT")).rejects.toThrow("simulated rename")
    expect(await fs.readFile(filepath, "utf-8")).toBe(original)

    renameSpy.mockRestore()
  })

  test("if rename fails, the orphaned temp file is cleaned up", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "data.txt")

    const renameSpy = spyOn(NFS, "rename").mockRejectedValue(new Error("rename boom"))

    await expect(Filesystem.write(filepath, "payload")).rejects.toThrow("rename boom")
    renameSpy.mockRestore()

    const entries = await fs.readdir(tmp.path)
    const leftovers = entries.filter((e) => e.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  })

  test("temp file is created with restrictive permissions (no world-readable window)", async () => {
    if (process.platform === "win32") return // chmod modes are a no-op on Windows
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "secret.json")

    // Intercept rename so the temp stays on disk for inspection, then read its mode.
    let capturedTmp: string | undefined
    const renameSpy = spyOn(NFS, "rename").mockImplementation(async (from, _to) => {
      capturedTmp = from.toString()
      throw new Error("hold for inspection")
    })

    await expect(Filesystem.write(filepath, '{"key":"secret"}')).rejects.toThrow("hold")
    renameSpy.mockRestore()

    expect(capturedTmp).toBeDefined()
    const stats = await fs.stat(capturedTmp!)
    // Temp must be owner-only (0o600) from creation, never 0o644/0o666.
    expect(stats.mode & 0o077).toBe(0)
    await NFS.rm(capturedTmp!, { force: true })
  })
})
