import { describe, expect, test } from "bun:test"
import { client, listen } from "../../src/util/rpc"

// A minimal in-process transport: captures the handler the client installs on
// the target, and lets the test inject raw incoming messages.
function makeTransport() {
  let incoming: ((evt: { data: string }) => void) | null = null
  const posted: string[] = []
  return {
    target: {
      postMessage: (data: string) => {
        posted.push(data)
      },
      set onmessage(fn: ((evt: { data: string }) => void) | null) {
        incoming = fn
      },
      get onmessage() {
        return incoming
      },
    },
    deliver(raw: string) {
      incoming?.({ data: raw })
    },
    posted,
  }
}

describe("rpc (B-2 defensive parsing)", () => {
  test("client.onmessage ignores malformed JSON without crashing the transport", async () => {
    const transport = makeTransport()
    client(transport.target)

    // A truncated/garbage message must not throw out of onmessage. Before the
    // fix, JSON.parse threw and the handler rejected unhandled.
    expect(() => transport.deliver("{ this is not json")).not.toThrow()
    expect(() => transport.deliver("")).not.toThrow()
  })

  test("client.onmessage ignores well-formed JSON that is not an rpc frame", async () => {
    const transport = makeTransport()
    client(transport.target)

    expect(() => transport.deliver(JSON.stringify({ type: "something.else" }))).not.toThrow()
    expect(() => transport.deliver(JSON.stringify({ unrelated: true }))).not.toThrow()
  })

  test("client still resolves rpc.result frames after defensive parsing", async () => {
    const transport = makeTransport()
    const c = client<{ add: (n: number) => number }>(transport.target)

    const pending = c.call("add", 41)
    // The request the client posted:
    const request = JSON.parse(transport.posted[0])
    // Simulate the worker replying with the matching id.
    transport.deliver(JSON.stringify({ type: "rpc.result", result: 42, id: request.id }))

    expect(await pending).toBe(42)
  })

  test("listen ignores malformed input and only handles rpc.request", async () => {
    const calls: number[] = []
    const rpc = {
      double: (n: number) => {
        calls.push(n)
        return n * 2
      },
    }
    // listen() assigns to globalThis.onmessage; capture and restore it.
    const previous = globalThis.onmessage
    const posted: string[] = []
    const previousPost = globalThis.postMessage
    try {
      globalThis.postMessage = (data: string) => posted.push(data)
      listen(rpc)
      const handler = globalThis.onmessage as (evt: { data: string }) => any

      // Malformed frame: ignored, no throw, double never called.
      expect(() => handler({ data: "not json" })).not.toThrow()
      expect(calls).toEqual([])

      // Non-rpc frame: ignored.
      expect(() => handler({ data: JSON.stringify({ type: "nope" }) })).not.toThrow()
      expect(calls).toEqual([])
    } finally {
      globalThis.onmessage = previous
      globalThis.postMessage = previousPost
    }
  })

  test("listen replies with an error for an unknown method instead of throwing", async () => {
    const rpc = { real: (x: number) => x }
    const posted: string[] = []
    const previous = globalThis.onmessage
    const previousPost = globalThis.postMessage
    try {
      globalThis.postMessage = (data: string) => posted.push(data)
      listen(rpc)
      const handler = globalThis.onmessage as (evt: { data: string }) => any

      // A request for a method that does not exist must not throw out of the
      // handler (which would hang the caller's pending promise) — it replies
      // with an error result carrying the original id.
      await handler({ data: JSON.stringify({ type: "rpc.request", method: "ghost", input: 1, id: 7 }) })

      expect(posted.length).toBe(1)
      const reply = JSON.parse(posted[0])
      expect(reply.type).toBe("rpc.result")
      expect(reply.id).toBe(7)
      expect(reply.error).toMatch(/unknown method/i)
    } finally {
      globalThis.onmessage = previous
      globalThis.postMessage = previousPost
    }
  })

  test("listen replies with an error when the handler throws", async () => {
    const rpc = { boom: () => { throw new Error("kaboom") } }
    const posted: string[] = []
    const previous = globalThis.onmessage
    const previousPost = globalThis.postMessage
    try {
      globalThis.postMessage = (data: string) => posted.push(data)
      listen(rpc)
      const handler = globalThis.onmessage as (evt: { data: string }) => any

      await handler({ data: JSON.stringify({ type: "rpc.request", method: "boom", input: null, id: 9 }) })

      expect(posted.length).toBe(1)
      const reply = JSON.parse(posted[0])
      expect(reply.id).toBe(9)
      expect(reply.error).toBe("kaboom")
    } finally {
      globalThis.onmessage = previous
      globalThis.postMessage = previousPost
    }
  })
})
