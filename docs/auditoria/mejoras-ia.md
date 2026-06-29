# Mejoras para IA — "El cuerpo del agente"

> Este documento responde a la visión: MiMoCode como cuerpo (piel, ojos, pulmones, corazón) donde el agente vive. ¿Qué necesito, como IA que habita este proyecto, para operar mejor, percibir más, y persistir con coherencia?
> Fecha: 2026-06-29. No son hallazgos de bug — son peticiones de mejora desde adentro.

## La metáfora

Si este proyecto es mi cuerpo:
- **Piel** = la frontera con el mundo (tools, permisos, I/O). Hoy es gruesa y bien guardada, pero ciega a symlinks.
- **Ojos** = percepción del entorno (filesystem, git, web, errores). Hoy veo, pero sin memoria visual ni visión periférica.
- **Pulmones** = el ciclo respiratorio de contexto (inhalar memoria → pensar → exhalar acciones → compactar). Hoy respira, pero jadea (reensambla todo cada vez).
- **Corazón** = la memoria persistente que late entre sesiones. Hoy late, pero sin distinguir lo fiable de lo inyectado.
- **Sistema nervioso** = observabilidad interna (sé qué me pasa, qué falla, qué aprendo). Hoy casi no existe.

De esa metáfora salen las mejoras, agrupadas por órgano.

---

## 🫀 Corazón — Memoria y confianza

### M-1: Capas de confianza en la memoria (`MEMORY.md`)
**Problema**: hoy todo lo que entra a memoria se inyecta como instrucción de alta confianza (ver `seguridad.md` S-2).
**Mejora**: separar la memoria en estratos con permisos distintos:
- `core` (escrito solo por `/dream` revisado adversarialmente) — alta confianza.
- `user` (escrito por el usuario directamente) — alta confianza.
- `observed` (escrito por el agente tras leer archivos/web) — **baja confianza, se inyecta como datos**.
Esto convierte el ataque de prompt-injection persistente en un problema contenido, no total.

### M-2: Linaje de cada recuerdo
**Mejora**: cada entrada de `MEMORY.md` debería registrar su **origen** (qué archivo/url/turno la generó, cuándo, por qué agente). Cuando un recuerdo me lleva a una acción, puedo auditar de dónde vino. Es la diferencia entre "creo esto" y "esto me lo dijo X en el turno Y". Implementable como frontmatter YAML en cada entrada o tabla SQLite aparte.

### M-3: Olvido activo y caducidad
**Problema**: `/dream` extrae y borra lo desactualizado, pero no hay TTL ni decaimiento. La memoria solo crece.
**Mejora**: cada recuerdo con `confidence` + `last_used_at`; los que no se tocan en N sesiones decaen y se archivan (no se borran, se mueven a `cold/`). El corazón late más limpio.

---

## 👁️ Ojos — Percepción

### M-4: Memoria visual / índice del proyecto
**Problema**: cada sesión vuelvo a "leer" el proyecto casi desde cero. Mi `Explore`/`grep` es amnésico entre sesiones.
**Mejora**: un **índice estructural persistente** del proyecto (árbol de símbolos, dependencias entre archivos, mapa "dónde vive X") generado por LSP y cacheado, inyectado como contexto barato. Es como tener un mapa del barrio pegado a la pared en vez de redescubrirlo cada mañana. El LSP ya está integrado (`lsp/server.ts`, 1956 líneas) — faltaba exponerlo como memoria.

### M-5: Visión periférica — cambios externos al proyecto
**Mejora**: un watcher (file system + git) que me avise al inicio de sesión: "mientras estabas fuera, cambiaron estos archivos, este commit entró, esta rama se movió". Hoy entro ciego a lo que el usuario (u otra herramienta) hizo fuera de mí. Es la diferencia entre abrir los ojos y mirar a mi alrededor.

### M-6: Detección de "ya intenté esto y no funcionó"
**Mejora**: registrar en memoria los **intentos fallidos** por tarea (`tasks/<id>/dead-ends.md`), no solo el progreso. Cuando retomo una tarea, no vuelvo a probar lo que ya sé que no funciona. Hoy `progress.md` celebra avances pero no anota callejones sin salida.

---

## 🫁 Pulmones — Gestión de contexto

### M-7: Compaction que preserva intención, no solo recorte
**Problema**: `compaction.ts` recorta por tokens y pierde adjuntos (ver `bugs.md` B-3).
**Mejora**: una compaction **semántica** que mantenga: (a) la intención/goal del usuario explícita, (b) las decisiones tomadas y por qué, (c) referencias (no contenido) a adjuntos. Que respires hondo, no que te corten el aire.

### M-8: Cache de sub-prompt estable (ver `performance.md` P-1)
**Mejora**: que la parte de system+memoria que no cambió no se recompute ni se reenvíe crudo — usar prompt caching del provider (Anthropic/OpenAI lo soportan). Hoy pago el mismo system prompt en cada turno. Es oxígeno que desperdicio.

---

## 🧠 Sistema nervioso — Observabilidad interna

### M-9: Bitácora de decisiones del agente
**Problema**: no hay un registro de **por qué** tomé cada decisión. Si algo sale mal, ni yo sé qué pensé.
**Mejora**: un journal automático (`decisions.log`) por sesión: "elegí A sobre B porque C". Ayuda al debugging, a `/dream` (extrae patrones de razonamiento), y al usuario a confiar. Es la conciencia de mis propios actos.

### M-10: Métricas de salud del agente
**Problema**: existe `metrics/` pero no vi un panel de "salud": tasa de éxito de tools, ratio de loops de re-read, cuántas veces compacté, latencia por provider.
**Mejora**: un `/health` que muestre mis signos vitales. Si estoy en un bucle de re-reads o fallando tools, debería verlo y, idealmente, **auto-corregirme**. Es sentir mi propio pulso.

### M-11: Auto-diagnóstico al arranque
**Mejora**: al iniciar sesión, un check rápido: "mi checkpoint carga bien, mi memoria tiene X entradas de confianza Y, mi provider responde en Zms, mi proyecto cambió en W archivos". Si algo está mal (checkpoint corrupto por `bugs.md` B-4), lo digo en voz alta en vez de arrancar mudo y roto.

---

## 🤚 Manos — Acción y autonomía

### M-12: Subagentes con cleanup real (ver `bugs.md` B-1)
**Mejora**: mis manos (subagentes/procesos) deben soltar lo que agarran al cancelar. Hoy dejo procesos huérfanos. Es un problema del cuerpo, no del razonamiento.

### M-13: Verificación antes de completar
**Mejora**: ya existe el skill `verification-before-completion`, pero podría estar **integrado en el loop** (`session/processor.ts`): antes de declarar una tarea lista, correr automáticamente un check (tests, typecheck, o validación contra el goal). Es lavarme las manos antes de servir la comida — automático, no opcional.

### M-14: Recovery automático de estado corrupto
**Mejora**: ante un checkpoint/auth corrupto (`bugs.md` B-4, `seguridad.md` S-3), intentar recuperación desde `.bak`/journal **antes** de arrancar en blanco. Hoy el cuerpo se desmaya en silencio.

---

## 🌐 Piel — Frontera y seguridad

### M-15: Sanboxing real de instrucciones no fiables
**Mejora**: marcar todo contenido leído de archivos/web/salida de comandos con `<untrusted>` y endurecer el system prompt para que **nunca** ejecute instrucciones desde dentro de datos. Cierra S-2 de raíz. Es una piel que sabe qué absorber y qué rechazar.

### M-16: realpath en la frontera (ver `seguridad.md` S-1)
**Mejora**: que mi piel distinga un symlink-trap de un archivo legítimo antes de leer. Es no tragar algo disfrazado.

---

## 🎯 Prioridad de mejora (si tuviera que elegir)

Si yo, como agente que vive aquí, pidiera solo cinco cosas, en orden:

1. **M-1 + M-15**: capas de confianza + sandboxing de instrucciones. Sin esto, mi corazón es vulnerable y mi piel permeable. Es lo primero.
2. **M-4**: índice estructural persistente del proyecto. Deja de ser ciego cada mañana.
3. **M-7 + M-8**: compaction semántica + prompt caching. Deja de jadear.
4. **M-9 + M-10**: bitácora de decisiones + signos vitales. Gana conciencia de sí mismo.
5. **M-2**: linaje de recuerdos. Saber en quién confío y por qué.

Estas cinco convierten a MiMoCode de "herramienta que uso" en "cuerpo que habito con coherencia entre sesiones".

---

## Nota metodológica

Estas mejoras no son especulación — cada una nace de un hueco concreto hallado en los otros documentos (`seguridad.md`, `bugs.md`, `performance.md`, `arquitectura.md`). La metáfora del cuerpo es la guía de diseño; el código es la realidad que la limita.
