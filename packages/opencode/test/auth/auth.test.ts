import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.defaultLayer, node))

describe("Auth", () => {
  it.live("set normalizes trailing slashes in keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set cleans up pre-existing trailing-slash entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((key) => key.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        expect(entry.type).toBe("wellknown")
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )

  it.live("remove deletes both trailing-slash and normalized keys", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set and remove are no-ops on keys without trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", {
          type: "api",
          key: "sk-test",
        })
        const data = yield* auth.all()
        expect(data["anthropic"]).toBeDefined()
        yield* auth.remove("anthropic")
        const after = yield* auth.all()
        expect(after["anthropic"]).toBeUndefined()
      }),
    ),
  )

  describe("MIMOCODE_AUTH_CONTENT env var (B-2 schema validation)", () => {
    // Reproduces B-2: the env-var branch used `JSON.parse(...) as Record<string, Info>`
    // with no schema validation, so a malformed payload (wrong shape, missing
    // `type`, junk) leaked through as a typed Record and blew up later in
    // unrelated code — or, with invalid JSON, was swallowed by an empty catch
    // that returned undefined implicitly. Both must be handled: invalid shape
    // is filtered out, invalid JSON returns an empty record instead of undefined.

    function withEnv<A, E, R>(value: string | undefined, body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          const prev = process.env.MIMOCODE_AUTH_CONTENT
          if (value === undefined) delete process.env.MIMOCODE_AUTH_CONTENT
          else process.env.MIMOCODE_AUTH_CONTENT = value
          return prev
        }),
        () => body,
        (prev) =>
          Effect.sync(() => {
            if (prev === undefined) delete process.env.MIMOCODE_AUTH_CONTENT
            else process.env.MIMOCODE_AUTH_CONTENT = prev
          }),
      )
    }

    it.live("valid env content with well-formed entries loads them (schema-validated)", () =>
      provideTmpdirInstance(() =>
        withEnv(
          JSON.stringify({
            "https://example.com": { type: "wellknown", key: "TOKEN", token: "abc" },
            anthropic: { type: "api", key: "sk-test" },
          }),
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const data = yield* auth.all()
            expect(data["https://example.com"]).toBeDefined()
            expect(data["anthropic"]).toBeDefined()
            const entry = data["https://example.com"]!
            if (entry.type === "wellknown") expect(entry.token).toBe("abc")
          }),
        ),
      ),
    )

    it.live("invalid JSON in env returns an empty record, not undefined (no crash)", () =>
      provideTmpdirInstance(() =>
        withEnv(
          "{ this is not json",
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const data = yield* auth.all()
            // Must be a usable empty record, never undefined — callers index into it.
            expect(data).toBeDefined()
            expect(Object.keys(data)).toEqual([])
          }),
        ),
      ),
    )

    it.live("valid JSON but wrong shape (missing required fields) is filtered out", () =>
      provideTmpdirInstance(() =>
        withEnv(
          JSON.stringify({ junk: { notAnAuthEntry: true }, anthropic: { type: "api" } }),
          Effect.gen(function* () {
            const auth = yield* Auth.Service
            const data = yield* auth.all()
            // Schema-invalid entries are dropped; only valid ones survive.
            expect(data["junk"]).toBeUndefined()
            expect(data["anthropic"]).toBeUndefined() // missing required `key`
            expect(Object.keys(data)).toEqual([])
          }),
        ),
      ),
    )
  })
})
