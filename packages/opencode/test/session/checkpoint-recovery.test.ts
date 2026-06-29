import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { readCheckpointFile } from "../../src/session/checkpoint-recovery"

describe("checkpoint recovery (B-4)", () => {
  test("absent: returns 'absent' status when the file does not exist", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")

    const result = await readCheckpointFile(filepath)

    expect(result.status).toBe("absent")
  })

  test("ok: returns content when the file is well-formed", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    const content = "Topic: implement feature X\n\n### Execution context\nblah\n"
    await fs.writeFile(filepath, content, "utf-8")

    const result = await readCheckpointFile(filepath)

    expect(result.status).toBe("ok")
    if (result.status === "ok") expect(result.content).toBe(content)
  })

  test("corrupt: flags an empty file (crash-truncated) instead of treating it as absent", async () => {
    // Reproduces B-4: a checkpoint truncated to 0 bytes by a crash must NOT be
    // silently treated as "no checkpoint" — that loses session state with no
    // signal. Today loadLatest returns undefined for both "missing" and "empty",
    // erasing the distinction.
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    await fs.writeFile(filepath, "", "utf-8")

    const result = await readCheckpointFile(filepath)

    expect(result.status).toBe("corrupt")
    if (result.status === "corrupt") {
      expect(result.error).toMatch(/empty|truncat/i)
    }
  })

  test("corrupt: flags a whitespace-only file", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    await fs.writeFile(filepath, "   \n\t  \n", "utf-8")

    const result = await readCheckpointFile(filepath)

    expect(result.status).toBe("corrupt")
    if (result.status === "corrupt") expect(result.error).toMatch(/empty|truncat/i)
  })

  test("corrupt: includes the decode error when bytes cannot be decoded", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "checkpoint.md")
    // Invalid UTF-8 sequence (lone continuation byte) that Bun's decoder rejects.
    await fs.writeFile(filepath, Buffer.from([0xed, 0xa0, 0x80, 0xff]), "binary")

    const result = await readCheckpointFile(filepath)

    // Bun's decoder is lenient on some byte sequences but rejects outright invalid
    // ones. If it decodes to non-empty text, that's "ok" (still not absent). The
    // guarantee under test is: never absent, and corrupt carries an error message.
    if (result.status === "corrupt") {
      expect(result.error.length).toBeGreaterThan(0)
    } else {
      expect(result.status).toBe("ok")
    }
  })

  test("absent: when the parent directory does not exist (ENOENT)", async () => {
    await using tmp = await tmpdir()
    const filepath = path.join(tmp.path, "nonexistent-dir", "nested", "checkpoint.md")

    const result = await readCheckpointFile(filepath)

    // A file in a missing directory simply does not exist — absent, not corrupt.
    expect(result.status).toBe("absent")
  })
})
