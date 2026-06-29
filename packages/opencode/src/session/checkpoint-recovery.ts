/**
 * Recovery-aware checkpoint reader.
 *
 * A checkpoint can be in one of three states on disk:
 *   - absent   — the file does not exist (a brand-new session). Silent.
 *   - ok       — the file exists and decodes into non-empty text. Returned as-is.
 *   - corrupt  — the file exists but is empty (crash-truncated) or fails to
 *                decode. This MUST be surfaced, not swallowed: treating a
 *                corrupt checkpoint as "absent" silently erases session state
 *                (B-4). Callers log the corruption so the user knows their
 *                checkpoint was lost rather than wondering why context vanished.
 *
 * Kept as a pure module (no Effect, no Service) so the load paths can use it
 * from both Effect.fn bodies and standalone async helpers, and so it is
 * directly testable without standing up the full checkpoint Service.
 */

export type ReadCheckpointResult =
  | { status: "absent" }
  | { status: "ok"; content: string }
  | { status: "corrupt"; error: string; raw?: string }

export async function readCheckpointFile(filePath: string): Promise<ReadCheckpointResult> {
  const file = Bun.file(filePath)
  const exists = await file.exists()
  if (!exists) return { status: "absent" }

  let text: string
  try {
    text = await file.text()
  } catch (err) {
    return { status: "corrupt", error: `failed to decode checkpoint: ${(err as Error).message}` }
  }

  // An empty (or whitespace-only) file is the signature of a write that was
  // interrupted right after truncation — the most common crash outcome. The
  // pre-write content is gone, but the session deserves to know.
  if (text.trim().length === 0) {
    return { status: "corrupt", error: "checkpoint file is empty (likely truncated by an interrupted write)" }
  }

  return { status: "ok", content: text }
}
