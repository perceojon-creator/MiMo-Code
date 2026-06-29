# Auditoría de MiMoCode

Primera auditoría integral del proyecto. Fecha: **2026-06-29**.
División de trabajo: GLM (yo) razona y dictamina; MiniMax (claude_m) investiga mecánicamente (búsquedas, extracción de código). Cada hallazgo fue **verificado contra el código** antes de documentarse.

## Documentos

| Documento | Qué contiene | Hallazgos |
|---|---|---|
| [arquitectura.md](./arquitectura.md) | Mapa del proyecto: subsistemas, layout, flujo de datos, archivos más grandes. | Contexto base. |
| [seguridad.md](./seguridad.md) | Fugas, validación de permisos, prompt-injection, path traversal. | 🔴 1 alto · 🟠 2 medio-alto · 🟡 2 bajo-medio |
| [bugs.md](./bugs.md) | Race conditions, recuperación de estado, `JSON.parse` sin validar, cancelación. | 🔴 1 alto · 🟠 3 medio · 🟡 2 bajo |
| [performance.md](./performance.md) | Latencia de prompt, FTS5, renders TUI, logging. | 🟠 2 medio · 🟡 3 bajo-medio |
| [mejoras-ia.md](./mejoras-ia.md) | Visión "cuerpo del agente": 16 mejoras para que MiMoCode sea un cuerpo coherente para la IA. | 5 prioridades seleccionadas. |

## Lectura recomendada

- **Si tienes 5 minutos**: `mejoras-ia.md` (la visión) + el "Acciones priorizadas" de `seguridad.md`.
- **Si vas a programar fixes ya**: `seguridad.md` S-1 → `bugs.md` B-1 → `bugs.md` B-2.
- **Si quieres entender el proyecto**: `arquitectura.md` primero.

## Top 5 acciones (de toda la auditoría)

1. **S-1 (seguridad)** — `realpathSync` en la frontera de paths (Unix) para cerrar symlink-traversal.
2. **B-1 (bugs)** — matar procesos hijos al cancelar subagentes.
3. **S-2 / M-15 (seguridad + mejoras-ia)** — sandboxing de instrucciones + capas de confianza en memoria.
4. **B-2 (bugs)** — validación `Schema.decodeUnknown` en auth/journal/RPC.
5. **S-3 / B-4 (seguridad + bugs)** — escritura atómica + recuperación no silenciosa de checkpoints.

## Estado

Documentos escritos, **sin commit** (esperando revisión del usuario). No se modificó código del proyecto.
