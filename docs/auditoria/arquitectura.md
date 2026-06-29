# Arquitectura de MiMoCode

> Mapa del proyecto. Generado en la primera auditoría (2026-06-29).
> Origen de los hechos: exploración directa del código en `packages/opencode/`.

## Qué es MiMoCode

MiMoCode es un **asistente de codificación AI nativo de terminal (TUI)** en TypeScript/Bun. Es un **fork de OpenCode** (`github.com/anomalyco/opencode`) al que Xiaomi le añadió: memoria persistente (SQLite + FTS5), gestión inteligente de contexto (checkpoints, compaction), subagentes, loops autónomos con `/goal`, modo compose (specs-driven), y auto-mejora vía `/dream` y `/distill`.

Modelo de negocio: canal gratuito limitado "MiMo Auto" + conexión a cualquier provider OpenAI-compatible.

## Layout del monorepo

```
packages/opencode/        ← NÚCLEO. Todo el razonamiento del agente vive aquí.
packages/opencode/src/cli/cmd/tui/   ← La TUI (única interfaz soportada hoy).
packages/app/             ← App web (NO soportada actualmente).
packages/console/         ← Consola (NO soportada).
packages/desktop/         ← App Electron (NO soportada).
packages/sdk/js/          ← SDK JS autogenerado (build: packages/sdk/js/script/build.ts).
packages/shared/          ← Código compartido (filesystem, utils). LO CRÍTICO de seguridad vive aquí.
packages/slack            ← Integración Slack.
sdks/, infra/, script/    ← Tooling, IaC (SST), scripts.
```

> El `AGENTS.md` declara explícitamente que el foco es la **TUI**; Web/App/Console no se mantienen.

## Subsistemas de `packages/opencode/src/` (los que importan)

| Subsistema | Directorio | Rol |
|---|---|---|
| **Agent / orquestación** | `agent/`, `acp/`, `actor/`, `tool/actor.ts` | Define el agente principal, los modos (build/plan/compose) y el spawn/cancel de subagentes. |
| **Sesión + contexto** | `session/` | El cerebro a corto plazo: `prompt.ts` (ensambla lo enviado al LLM), `processor.ts` (bucle tool-call), `compaction.ts`/`overflow.ts` (recorte de contexto), `checkpoint.ts`, `goal.ts`, `max-mode.ts`. |
| **Memoria persistente** | `memory/`, `session/checkpoint*.ts`, `session/auto-dream.ts` | Cerebro a largo plazo: SQLite + FTS5. `MEMORY.md`, `checkpoint.md`, `notes.md`, `tasks/<id>/progress.md`. |
| **Providers LLM** | `provider/` | Adaptadores OpenAI-compatible, Anthropic, Google, Copilot. Maneja credenciales y headers. |
| **Tools** | `tool/` | Las herramientas del agente: `bash.ts`, `edit.ts`, `write.ts`, `read.ts`, `grep`, `glob`, `task.ts`, `memory.ts`, `webfetch`, `mcp-exa.ts`, etc. |
| **Permisos** | `permission/`, `tool/external-directory.ts`, `tool/memory-path-guard.ts` | Boundary de seguridad: qué puede tocar el agente. |
| **MCP** | `mcp/` | Model Context Protocol (servidores externos). OAuth propio. |
| **Shell / ejecución** | `tool/bash.ts`, `tool/shell-tokenize.ts`, `tool/shell-wrap.ts`, `pty/`, `actor/spawn.ts` | Cómo se ejecutan comandos del usuario. |
| **TUI** | `cli/cmd/tui/` | Interfaz. `thread.ts`, `worker.ts`, plugins, i18n (es incluido), voice/vad. |
| **Persistencia** | `storage/`, `history/`, `snapshot/` | SQLite, historial FTS, snapshots de estado. |
| **Server / API** | `server/` | HTTP API local (expone sesión, archivos, bash, pty a la TUI/app). |
| **Auth / cuenta** | `auth/`, `account/` | Credenciales en `auth.json` (chmod 600), OAuth. |
| **Workflow / compose** | `workflow/` | Runtime de workflows, sandbox, persistencia (journal). |
| **Config** | `config/` | `.mimocode/mimocode.json` (proyecto) y global. Schema-driven. |

## Los 10 archivos más grandes (zonas de riesgo de complejidad)

| Líneas | Archivo | Por qué importa |
|---|---|---|
| **3878** | `session/prompt.ts` | Ensambla TODO lo que va al LLM. Epicentro de prompt-injection y de performance. Demasiado grande. |
| 1956 | `lsp/server.ts` | Integración LSP. |
| 1788 | `provider/provider.ts` | Construye headers/credenciales para todos los providers. |
| 1787 | `acp/agent.ts` | Orquestación del agente. |
| 1770 | `provider/sdk/copilot/responses/...` | Adapter Copilot. |
| 1647 | `cli/cmd/github.ts` | Integración GitHub. |
| **1560** | `session/checkpoint.ts` | Lógica de checkpoints. Sin atomicidad de escritura (ver `bugs.md`). |
| 1447 | `workflow/runtime.ts` | Runtime de workflows. |
| 1376 | `provider/transform.ts` | Transformación de mensajes. |
| 1328 | `server/routes/instance/session.ts` | API HTTP de sesión. |

## Flujo de datos principal (un turno del usuario)

```
Usuario escribe en TUI
  → session/processor.ts recibe el mensaje
  → session/prompt.ts ensambla contexto:
       system prompt + memoria (MEMORY.md, checkpoint, FTS5 search) + historial + tools
  → provider/ manda al LLM
  → LLM responde con tool_calls
  → processor.ts ejecuta cada tool vía tool/
       └─ cada tool pasa por permission/ y external-directory.ts / memory-path-guard.ts
  → resultados se añaden al historial
  → si el contexto excede usable(): compaction.ts/overflow.ts recortan
  → si hay goal: goal.ts pide al juez que valide antes de parar
  → bucle hasta que el LLM no pide más tools
```

## Superpoderes del proyecto (lo que lo diferencia de OpenCode)

1. **Memoria persistente con FTS5** — recuperación semántica barata sin embeddings.
2. **Checkpoints + context reconstruction** — el agente "recuerda" tras saturar el contexto.
3. **Subagentes con lifecycle** — fork/cancel/paralelo, comparten contexto.
4. **`/goal` con juez independiente** — evita paradas optimistas prematuras.
5. **`/dream` + `/distill`** — auto-extracción de conocimiento y workflows → skills.

## Notas estructurales

- **Stack TS pesado**: Effect (4.0.0-beta) en todo el core, Drizzle ORM, Zod 4, SolidJS (app). Muchas deps en beta.
- **Bun-first**: `Bun.file()`, `bunfig.toml`, `packageManager: bun@1.3.14`.
- **6 deps con patches manuales** (`patchedDependencies`) — deuda de mantenimiento.
- **i18n**: 7 idiomas incluyendo `es`.
- **Tests**: `bun:test`, no se pueden correr desde la raíz (guard `do-not-run-tests-from-root`).

Ver también: [[seguridad]] · [[bugs]] · [[performance]] · [[mejoras-ia]]
