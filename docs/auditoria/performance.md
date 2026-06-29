# Auditoría de Performance — MiMoCode

> Hallazgos basados en lectura del código. No se ejecutaron benchmarks (no se pudo correr el TUI en este entorno). Fecha: 2026-06-29.

## Resumen ejecutivo

No hay cuellos de botella algorítmicos obvios (las queries son FTS5 indexadas, no escaneos lineales). El riesgo principal es **latencia acumulativa en el ensamblaje del prompt** — `prompt.ts` (3878 líneas) construye el contexto en cada turno y, según los comentarios del código, ya inyecta "cost ~120 tokens per turn" solo para el protocolo de recall de memoria. Las áreas a vigilar son: reensamblaje completo del contexto tras compaction, búsqueda FTS5 por turno, y renders de la TUI.

---

## 🟠 MEDIO — P-1: Reensamblaje completo del contexto tras cada compaction/overflow

**Archivo**: `session/prompt.ts` (3878 líneas, la función de ensamblaje), `session/compaction.ts`, `session/overflow.ts`.

Cada turno, `prompt.ts` reconstruye todo el bloque que se envía al LLM: system prompt + memoria (FTS5 search + archivos MEMORY/checkpoint) + historial + definiciones de tools. Tras un `overflow`, el historial se recorta y se **reensambla desde cero**. En sesiones largas con compaction frecuente, esto significa re-leer `MEMORY.md`, `checkpoint.md`, ejecutar `memory.search` FTS5, y reformatear en cada rebuild.

No se vio **caching** del sub-prompt estable entre turnos (la parte de system+memoria que no cambia si no se modificó `MEMORY.md`).

**Severidad**: Media (latencia + tokens que se pagan en cada rebuild).
**Fix**: cache incremental del system+memoria keyed por mtime de `MEMORY.md`/`checkpoint.md` + hash del agente; reutilizar entre turnos mientras no cambien.

---

## 🟠 MEDIO — P-2: `memory.search` (FTS5) potencialmente en cada turno

**Archivo**: `memory/service.ts:102-117`, invocada desde el ensamblaje del prompt.

La query FTS5 se corre con `LIMIT ?` y `ORDER BY bm25`. Es indexada, así que es rápida, pero si se ejecuta **varias veces por turno** (recall proactivo + tool explícita + subagentes) el coste se multiplica. El comentario en `prompt.ts:2469-2474` confirma que se inyecta un protocolo de recall "para mantener caliente el reflejo de buscar en memoria" en cada post-rebuild — es decir, se incentiva al modelo a llamar `memory.search` otra vez.

**Severidad**: Media.
**Fix**: deduplicar búsquedas idénticas en una misma sesión dentro de un turno, o un cache LRU por query+mtime.

---

## 🟡 BAJO-MEDIO — P-3: `prompt.ts` monolítico de 3878 líneas

**Archivo**: `session/prompt.ts`.

No es un bug de performance por sí, pero un archivo de 3878 líneas que ensambla todo es:
- Difícil de optimizar localmente (cualquier cambio toca el epicentro).
- Probablemente contenga ramas muertas y duplicación que inflan el output de tokens.
- Un obstáculo para caching parcial (P-1).

**Severidad**: Baja-media (deuda de mantenibilidad que frenará optimizaciones futuras).
**Fix**: descomponer en: `assembleSystem`, `assembleMemory`, `assembleHistory`, `assembleTools` — cada una cacheable y testeable por separado.

---

## 🟡 BAJO-MEDIO — P-4: TUI — render sin virtualización confirmada en algunas vistas

**Archivos**: `cli/cmd/tui/` (basado en `@opentui/solid`), `virtua` está en el catalog de dependencias (`package.json:74`) para listas largas.

No se auditaron a fondo los renders, pero el catálogo incluye `virtua` (virtualización) lo cual sugiere que las listas largas (historial de mensajes, logs) ya están cubiertas. **Riesgo**: si algún componente mapea mensajes sin virtualización, una sesión de cientos de turnos puede causar lag. Requiere verificación empírica en el TUI.

**Severidad**: Baja-media (sin confirmar).
**Acción**: medir FPS / tiempo de render con una sesión de 500+ mensajes.

---

## 🟡 BAJO — P-5: Logging estructurado puede serializar payloads grandes

**Archivos**: `effect/app-runtime.ts`, `metrics/`, comentarios de redacción en `config/mcp.ts:137-162`.

La redacción de credenciales existe, pero no se vio truncamiento de payloads grandes (respuestas de tools, bodies de providers). Un `console.debug` de una respuesta de `read` sobre un archivo de 50k líneas, o el body de un provider en beta, puede inundar logs y consumir I/O.

**Severidad**: Baja.
**Fix**: truncar por defecto cualquier campo de log > N KB con un marker `[truncated]`.

---

## ✅ Lo que está bien

- **FTS5 con `bm25`** para ranking de memoria — es la opción correcta, sin embeddings ni latencia de red.
- **`compaction.ts` con presupuesto de tokens** (`preserveRecentBudget`, min/max) — controla el crecimiento.
- **`SELECT ... LIMIT ?`** en todas las queries de memoria/historial — no hay scans ilimitados.
- **`virtua` para virtualización** de listas largas.
- **Bun runtime** — más rápido que Node para I/O y arranque.

---

## Acciones priorizadas

| # | Acción | Esfuerzo | Impacto |
|---|---|---|---|
| 1 | P-1: cache incremental de system+memoria por mtime | Medio | Reduce latencia y tokens por turno |
| 2 | P-3: descomponer `prompt.ts` en 4 módulos | Medio | Habilita P-1 y futuras optimizaciones |
| 3 | P-2: dedup de `memory.search` por turno | Pequeño | Evita búsquedas redundantes |
| 4 | P-4: medir render TUI con 500+ mensajes | Pequeño | Confirmar o descartar cuello |
| 5 | P-5: truncar campos de log grandes | Pequeño | Evita I/O explosivo |
