type Definition = {
  [method: string]: (input: any) => any
}

export function listen(rpc: Definition) {
  onmessage = async (evt) => {
    // A malformed message (truncated, non-JSON, or a non-RPC control frame) must
    // not crash the worker's message loop. Parse defensively and ignore anything
    // that isn't a well-formed rpc.request.
    let parsed: any
    try {
      parsed = JSON.parse(evt.data)
    } catch {
      return
    }
    if (parsed?.type !== "rpc.request") return
    // Unknown method: reply with an error result instead of throwing a TypeError
    // out of the handler (which would leave the caller's pending request hung).
    const handler = rpc[parsed.method]
    if (typeof handler !== "function") {
      postMessage(JSON.stringify({ type: "rpc.result", result: undefined, error: `unknown method: ${parsed.method}`, id: parsed.id }))
      return
    }
    try {
      const result = await handler(parsed.input)
      postMessage(JSON.stringify({ type: "rpc.result", result, id: parsed.id }))
    } catch (err) {
      postMessage(JSON.stringify({ type: "rpc.result", result: undefined, error: (err as Error).message, id: parsed.id }))
    }
  }
}

export function emit(event: string, data: unknown) {
  postMessage(JSON.stringify({ type: "rpc.event", event, data }))
}

export function client<T extends Definition>(target: {
  postMessage: (data: string) => void | null
  onmessage: ((this: Worker, ev: MessageEvent<any>) => any) | null
}) {
  const pending = new Map<number, (result: any) => void>()
  const listeners = new Map<string, Set<(data: any) => void>>()
  let id = 0
  target.onmessage = async (evt) => {
    let parsed: any
    try {
      parsed = JSON.parse(evt.data)
    } catch {
      return
    }
    if (parsed?.type === "rpc.result") {
      const resolve = pending.get(parsed.id)
      if (resolve) {
        resolve(parsed.result)
        pending.delete(parsed.id)
      }
    }
    if (parsed?.type === "rpc.event") {
      const handlers = listeners.get(parsed.event)
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed.data)
        }
      }
    }
  }
  return {
    call<Method extends keyof T>(method: Method, input: Parameters<T[Method]>[0]): Promise<ReturnType<T[Method]>> {
      const requestId = id++
      return new Promise((resolve) => {
        pending.set(requestId, resolve)
        target.postMessage(JSON.stringify({ type: "rpc.request", method, input, id: requestId }))
      })
    },
    on<Data>(event: string, handler: (data: Data) => void) {
      let handlers = listeners.get(event)
      if (!handlers) {
        handlers = new Set()
        listeners.set(event, handlers)
      }
      handlers.add(handler)
      return () => {
        handlers!.delete(handler)
      }
    },
  }
}
