# Auditoría de Bugs y Correctitud — MiMoCode

> Hallazgos verificados contra el código. Fecha: 2026-06-29.
> Cada hallazgo cita archivo:línea.

## Resumen ejecutivo

El core usa **Effect TS** para todo el manejo de errores y concurrencia, lo que elimina categorías enteras de bugs (promesas no awaitadas, excepciones no capturadas). El bucle del procesador (`session/processor.ts`) está bien estructurado. **Sin embargo** hay bugs reales en: persistencia (no atómica, recuperación silenciosa), cancelación de subagentes (sin cleanup de recursos del SO), y varios `JSON.parse` sin validación de tipo.

---

## 🔴 ALTO — B-1: Cancelación de subagentes no limpia procesos/file handles

**Archivos**: `actor/spawn.ts:698-710`, `actor/spawn.ts:579-589`, `tool/actor.ts:619-755`.

```ts
const cancel = Effect.fn("Actor.cancel")(function* (sessionID, actorID, mode) {
  const children = yield* actorReg.listByParent(sessionID, actorID)
  yield* Effect.forEach(children, (c) => cancel(sessionID, c.actorID, mode), {...})
  yield* state.cancelActor(sessionID, actorID)
  yield* actorReg.updateStatus(...).pipe(Effect.ignore)
  yield* Effect.sync(() => forkContexts.delete(actorID))   // ← solo borra un Map
})
```

La cancelación solo actualiza estado en el registry y borra entradas de un `Map` en memoria. **No mata procesos hijos** que el subagente haya podido spawnear (vía `tool/bash.ts` o `pty/`), ni cierra file descriptors. El `abortSignal` se propaga a tools vía `ctx.abort`, pero si el subagente ya había lanzado un `bash` de larga duración en background (`detached: true` en `bash.ts:329`), ese proceso queda **huérfano y corriendo** tras la cancelación.

**Síntoma**: procesos zombie, consumo de CPU/memoria, o comandos que siguen modificando archivos después de que el usuario cree que se cancelaron.

**Severidad**: Alta (es un comportamiento incorrecto visible para el usuario y un riesgo de daño no intencionado).
**Fix**: en `cancel`, además de actualizar estado, recorrer los `forkContexts`/registros de procesos y enviar `SIGTERM`/`SIGKILL` (en `forced`) a cada `ChildProcess` tracking que el actor (y sus hijos) tengan vivo.

---

## 🟠 MEDIO-ALTO — B-2: `JSON.parse` sin validación de tipo en caminos críticos

**Archivos**: múltiples — los más sensibles:

- `auth/index.ts:61` — `return JSON.parse(process.env.MIMOCODE_AUTH_CONTENT)` → si la env var está mal formada, el proceso entero de auth cae.
- `workflow/persistence.ts:274` — `ev = JSON.parse(line) as JournalEvent` → un journal corrupto revierte el workflow a estado inválido.
- `control-plane/sse.ts:49` — `onEvent(JSON.parse(raw))` → SSE mal formado crashea el handler.
- `util/rpc.ts:7,27` — `JSON.parse(evt.data)` → RPC con el cliente TUI/app; payload mal formado crashea el transport.
- `provider/error.ts:88`, `provider/provider.ts:1508,780` — parseo de bodies de error de providers externos (no fiables).
- `plugin/mimo.ts:57`, `plugin/codex.ts:63` — parseo de credenciales/tokens desencriptados.

El cast `as Type` después de `JSON.parse` **no valida**; un payload con la forma incorrecta se cuela como tipo correcto y explota mucho más tarde, en código no relacionado, dificultando el debug.

**Severidad**: Media-alta. En el caso de `auth.json`/journal/RPC, un único byte corrupto puede dejar al usuario sin poder arrancar.
**Fix**: usar `Schema.decodeUnknown(Schema.parse(...))` (ya tienen Effect/Schema) en las entradas de datos no fiables, al menos en auth, journal y RPC.

---

## 🟠 MEDIO — B-3: `overflow` en compaction pierde adjuntos binarios/media

**Archivo**: `session/compaction.ts:250-266` y la rama de transformación de partes.

Cuando el contexto rebasa y se reconstruye (`overflow: true`), el código busca el último mensaje de usuario previo al padre para "replay". Si ese mensaje o los recortados contenían archivos adjuntos/imágenes, al reconstruir se sustituyen por un placeholder de texto (`[Attached <mime>: <filename>]`) — el **contenido binario se descarta**. En la siguiente iteración el modelo ya no "ve" la imagen/archivo que el usuario había adjuntado, pero puede seguir referenciándolo en su razonamiento → alucinaciones o respuestas rotas.

**Severidad**: Media. Sutil, afecta a sesiones largas con adjuntos.
**Fix**: preservar referencias a adjuntos (path/ID) en el resumen de compaction para que la tool pueda releerlos bajo demanda, en vez de sustituir por texto estático.

---

## 🟠 MEDIO — B-4: Recuperación de checkpoint silenciosa oculta corrupción

**Archivo**: `session/checkpoint.ts:1002-1007`.

```ts
const content = yield* Effect.promise(() =>
  Bun.file(checkpointPath(sessionID)).text().catch(() => ""),   // ← traga el error
)
return content || undefined
```

Cualquier fallo de lectura (archivo corrupto por B-no-atomicidad de `seguridad.md` S-3, permisos, IO) devuelve `""` → `undefined` → la sesión arranca **sin checkpoint** como si nunca hubiera existido. El usuario no recibe ningún aviso de que se perdió estado. Peor: el `checkpoint-writer` puede entonces reescribir un checkpoint nuevo sobre datos ya inconsistentes.

**Severidad**: Media (pérdida silenciosa de trabajo/estado).
**Fix**: distinguir "archivo no existe" (legítimo → undefined) de "archivo existe pero no se puede leer/parsear" (→ log + notificar al usuario + intentar recuperar de un `.bak`).

---

## 🟡 BAJO-MEDIO — B-5: `FTS5 query` deja tokens CJK sin tokenizar fino

**Archivo**: `memory/fts-query.ts:28-37`.

```ts
const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? []
const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`)
return quoted.join(" OR ")
```

El regex `\p{L}` agrupa correctamente caracteres, pero en CJK (chino/japonés) no hay separadores de palabra, así que "記憶システム" se convierte en **un solo token gigante** `"記憶システム"` que solo matchea FTS si el documento contiene exactamente esa secuencia contigua. La búsqueda parcial ("記憶") no la encuentra. Para un producto con foco en Asia (MiMo es de Xiaomi) esto es relevante: la `memory.search` será débil en CJK.

**Severidad**: Baja-media (degradación funcional, no crash).
**Fix**: usar el tokenizer `unicode61` con `tokenchars` o un `trigram` tokenizer de SQLite para CJK, o pre-tokenizar n-gramas a nivel de query.

---

## 🟡 BAJO — B-6: `hasContent` en overflow es frágil

**Archivo**: `session/compaction.ts:260-265`.

La variable `hasContent` se calcula con un `.some` que comprueba que quede algún mensaje de usuario sin compaction. Si **todos** los mensajes de usuario están compactados, `replay = undefined` y se envía **todo** el historial (sin recorte) → posible re-overflow inmediato. Es un caso límite pero posible en sesiones largas con mucha compaction acumulada.

**Severidad**: Baja.
**Fix**: cuando no haya replay válido, forzar al menos el recorte por `select()` en vez de devolver todo.

---

## ✅ Lo que está bien

- **`await` en `.map` siempre con `Promise.all`/`Effect.forEach`** — MiniMax reportó 0 ocurrencias de `await` suelto en map/forEach. Effect fuerza el patrón correcto.
- **`processor.ts:687-755`** maneja interrupciones (`Effect.onInterrupt`, `Cause.hasInterruptsOnly`) correctamente — distingue cancelación de error real.
- **Tool execution** (`processor.ts:859-892`) captura sync y async de forma uniforme con `Effect.tryPromise`.
- **`select()` en compaction** preserva los últimos N turnos con presupuesto (min 2K, max 8K) — heurística razonable.

---

## Acciones priorizadas

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | B-1: matar procesos hijos en `Actor.cancel` | Medio | Cierra fugas de procesos y daño no intencionado |
| 2 | B-2: `Schema.decodeUnknown` en auth/journal/RPC | Medio | Robustez ante datos corruptos |
| 3 | B-4: distinguir "no existe" vs "corrupto" en checkpoints | Pequeño | Deja de perder estado en silencio |
| 4 | B-3: preservar refs de adjuntos en compaction | Medio | Sesiones largas no pierden contexto visual |
| 5 | B-5: tokenizer CJK para FTS5 | Pequeño | Búsqueda útil en chino/japonés |
| 6 | B-6: forzar `select()` cuando no hay replay | Pequeño | Evita re-overflow |
