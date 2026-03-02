# OpenCode Slave Plugin

## Descripcion

Plugin para OpenCode que permite definir y ejecutar tareas automatizadas dentro de un repositorio, con soporte para ejecucion secuencial, paralela y en ramas git aisladas mediante worktrees.

---

## Objetivo

Disenar un sistema robusto para:

- Definir tareas dentro del propio repo.
- Ejecutarlas de forma deterministica y auditable.
- Soportar ejecucion paralela en ramas aisladas.
- Recuperarse de errores, cierres inesperados y conflictos de estado.

---

## Principios de diseno

- Determinismo: mismo input, mismo orden de ejecucion.
- Seguridad: no ejecutar scripts locales peligrosos por defecto.
- Atomicidad: escritura segura de estado en disco.
- Idempotencia: comandos repetidos no deben corromper estado.
- Portabilidad: comportamiento consistente en Windows, macOS y Linux.

---

## Modo autonomia maxima

El sistema debe intentar resolver cada tarea de forma autonoma antes de escalar a una persona.

Reglas:

- Investigar primero, preguntar despues: no escalar sin agotar la investigacion local.
- Agotar contexto tecnico: analizar codigo relacionado, tests, historial git, configuracion y logs.
- Consultar base de datos cuando aplique: esquema, constraints, indices, migraciones y consultas reales.
- Probar multiples enfoques: ejecutar iteraciones de intento y verificacion antes de rendirse.
- Escalar solo en bloqueos reales: credenciales faltantes, decisiones de negocio ambiguas o riesgo destructivo.

Politica de escalado minimo:

- El agente NO debe pedir ayuda humana por dudas superficiales.
- Debe registrar que fuentes inspecciono y por que descarto cada alternativa.
- Solo puede escalar cuando `investigationBudget` este agotado o exista bloqueo duro.

---

## Estructura de directorios

```
.opencode-slave/
  config.json
  tasks.json
  tasks.lock
  logs/
    scheduler.log
  templates/
    pr.md
  tasks/
    {task-name}/
      TASK.md
      task.json
      context/
      output/
        result.json
      logs/
        execution.log
      pre-run.sh
      pre-run.ps1
      pre-run.cmd
      post-run.sh
      post-run.ps1
      post-run.cmd

# Worktrees temporales (modo paralelo):
../repo-slave-{task-name}/
```

Notas:
- `tasks.lock` se usa para evitar condiciones de carrera al escribir `tasks.json`.
- `logs/` separa logs del scheduler de logs por tarea.
- `task.json` es metadata opcional por tarea para sobreescribir defaults.

---

## Validacion del nombre de tarea

`{name}` debe cumplir:

- Regex: `^[a-z0-9][a-z0-9-_]{1,62}$`
- No se permite `/`, `\`, `..`, espacios ni caracteres reservados de git branch.
- Debe ser unico.

Si falla validacion, el comando debe abortar sin crear archivos.

---

## Comandos

### `/slave-task {name}`

Crea una nueva tarea en el repositorio.

Comportamiento:

1. Si no existe `.opencode-slave/`, lo crea con estructura base y archivos iniciales.
2. Valida `{name}`.
3. Si la tarea ya existe (carpeta o registro), comando idempotente: no duplica, devuelve aviso.
4. Crea la carpeta `.opencode-slave/tasks/{name}/`.
5. Crea `TASK.md` y `task.json` plantilla.
6. Registra en `tasks.json` con estado `pending`.

Plantilla de `TASK.md`:

```markdown
# Task: {name}

## Descripcion
<!-- Que debe hacer el agente -->

## Contexto
<!-- Archivos relevantes y decisiones previas -->

## Fuentes obligatorias de investigacion
<!-- Tablas DB, rutas del codigo, logs, docs internas, PRs previos -->

## Criterios de exito
<!-- Condiciones concretas para marcar finished -->

## Comandos de verificacion
<!-- Pruebas, build, lint, etc -->

## Limites de escalado humano
<!-- Cuando SI puede preguntar y cuando NO -->
```

Plantilla de `task.json` (opcional por tarea):

```json
{
  "priority": 100,
  "dependsOn": [],
  "maxRetries": 3,
  "timeoutSec": 1800,
  "investigationBudget": 8,
  "requireDbIntrospection": "auto",
  "tags": [],
  "executor": {
    "commandTemplate": "opencode run --task-file TASK.md"
  }
}
```

---

### `/slave-start`

Ejecuta tareas pendientes en modo secuencial.

Comportamiento:

1. Adquiere lock (`tasks.lock`).
2. Sincroniza carpetas de `tasks/` con `tasks.json` (alta automatica de faltantes).
3. Ejecuta fase de investigacion autonoma por tarea (codigo, tests, logs, DB cuando aplique).
4. Valida dependencias y detecta ciclos (`dependsOn`).
5. Ordena tareas por: `priority ASC`, `createdAt ASC`, `name ASC`.
6. Ejecuta tareas elegibles (`pending` y sin dependencias bloqueantes).
7. Si falla, itera nuevas estrategias hasta `investigationBudget` o `maxRetries`.
8. Libera lock al finalizar.

Flags:

- `/slave-start --dry-run`: no ejecuta, solo muestra plan de ejecucion y bloqueos.
- `/slave-start --background`: ejecuta en segundo plano y permite tareas de larga duracion.

---

### `/slave-start --parallel`

Ejecuta en paralelo tareas independientes usando git worktrees.

Reglas:

- Respeta `maxParallel` en `config.json`.
- Nunca ejecuta en paralelo tareas con dependencia directa o indirecta.
- Cada tarea usa rama propia `slave/{name}`.

Creacion de worktree (obligatoriamente desde rama base):

```bash
git fetch origin {baseBranch}
git worktree add "{worktreePath}" -b "slave/{name}" "origin/{baseBranch}"
```

Fallback si no existe remoto:

```bash
git worktree add "{worktreePath}" -b "slave/{name}" "{baseBranch}"
```

---

### `/slave-start --worktree {name}`

Ejecuta solo una tarea en worktree aislado sin lanzar el resto.

---

### `/slave-status`

Muestra estado de todas las tareas con columnas minimas:

- Name
- Status
- Priority
- Branch
- Retries
- Lease
- Last Error

---

### `/slave-logs {name}`

Muestra logs de la tarea (`tasks/{name}/logs/execution.log`).

---

### `/slave-reset {name}`

Resetea tarea a `pending`, limpia `error`, reinicia lease y permite nueva ejecucion.

---

### `/slave-cancel {name}`

Cancela una tarea en `started`. Debe terminar proceso activo y limpiar lease.

---

### `/slave-validate`

Valida integridad sin ejecutar:

- Nombres de tareas
- Duplicados
- Dependencias inexistentes
- Ciclos en grafo de dependencias
- JSON schema y `schemaVersion`

---

### `/slave-resume`

Recupera estado tras cierre inesperado:

- Revisa tareas en `started` con lease vencido.
- Si `retries < maxRetries`, mueve a `pending`.
- Si `retries >= maxRetries`, mueve a `error`.

---

### `/slave-prune-worktrees`

Limpia worktrees huerfanos y referencias obsoletas (`git worktree prune`).

---

## Ejecucion de hooks (multiplataforma)

Antes y despues de cada tarea se ejecuta un hook opcional por plataforma:

Windows:
1. `pre-run.ps1` / `post-run.ps1`
2. `pre-run.cmd` / `post-run.cmd`

macOS/Linux:
1. `pre-run.sh` / `post-run.sh`

Si no existe hook para la plataforma actual, se ignora sin error.

---

## Investigacion previa obligatoria (sin intervencion humana)

Antes de modificar codigo, cada tarea debe completar un ciclo minimo:

1. Descubrimiento en repositorio:
   - Buscar implementaciones similares.
   - Trazar el flujo desde entrada hasta efectos secundarios.
   - Identificar archivos candidatos y pruebas existentes.
2. Analisis de datos (si aplica):
   - Inspeccionar esquema de DB y migraciones.
   - Validar constraints, tipos y cardinalidades.
   - Revisar consultas lentas/errores historicos.
3. Hipotesis y plan:
   - Proponer al menos 2 estrategias.
   - Elegir una estrategia con criterio (riesgo, complejidad, impacto).
4. Verificacion:
   - Ejecutar tests y checks definidos en `TASK.md`.
   - Si falla, reintentar con estrategia alternativa hasta agotar presupuesto.

Registro obligatorio por intento:

- Fuentes consultadas.
- Hipotesis aplicada.
- Resultado de verificacion.
- Motivo de descarte o continuidad.

---

## Maquina de estados

Estados soportados:

- `pending`
- `started`
- `finished`
- `error`
- `cancelled`

Transiciones permitidas:

- `pending -> started | cancelled`
- `started -> finished | error | cancelled`
- `error -> pending | cancelled`
- `finished -> pending` (solo con `/slave-reset`)
- `cancelled -> pending` (solo con `/slave-reset`)

Cualquier transicion fuera de esta tabla debe rechazarse.

---

## Archivo de tareas (`tasks.json`)

`tasks.json` guarda estado global y runtime metadata.

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-02-24T10:00:00Z",
  "tasks": [
    {
      "name": "auth-refactor",
      "status": "pending",
      "priority": 1,
      "dependsOn": [],
      "createdAt": "2026-02-24T10:00:00Z",
      "startedAt": null,
      "finishedAt": null,
      "lastHeartbeatAt": null,
      "leaseOwner": null,
      "leaseExpiresAt": null,
      "retries": 0,
      "maxRetries": 3,
      "investigationBudget": 8,
      "investigationUsed": 0,
      "researchSummary": null,
      "timeoutSec": 1800,
      "branch": null,
      "worktree": null,
      "error": null,
      "tags": ["backend"],
      "attempts": []
    }
  ]
}
```

`attempts[]` recomendado:

```json
{
  "attempt": 1,
  "startedAt": "2026-02-24T10:02:10Z",
  "finishedAt": "2026-02-24T10:04:45Z",
  "exitCode": 1,
  "error": "Tests failed",
  "sourcesChecked": [
    "src/services/auth.ts",
    "db/schema.sql",
    "tests/auth.spec.ts"
  ],
  "strategy": "Ajuste de validacion y migracion incremental",
  "logFile": ".opencode-slave/tasks/auth-refactor/logs/execution.log"
}
```

---

## Escritura atomica y lock

Para evitar corrupcion en paralelo:

1. Crear/adquirir `tasks.lock` con owner + timestamp.
2. Leer `tasks.json`.
3. Escribir cambios a `tasks.json.tmp`.
4. Renombrar atomicamente `tasks.json.tmp -> tasks.json`.
5. Liberar lock.

Si lock esta stale (TTL vencido), puede ser recuperado por `/slave-resume`.

---

## Heartbeat y recuperacion tras crash

Mientras una tarea esta en `started`:

- Actualizar `lastHeartbeatAt` cada `heartbeatSec`.
- Mantener `leaseExpiresAt = now + leaseTtlSec`.

Si el proceso cae:

- `/slave-resume` detecta lease vencido y decide reintento o error final.

---

## Ejecucion de larga duracion (modo autonomo)

Para tareas largas sin intervencion humana:

- Soporte de ejecucion en background (`/slave-start --background`).
- Persistencia de runtime en `.opencode-slave/runtime/`.
- Checkpoints periodicos para continuar tras reinicio del proceso.
- Reanudacion automatica al volver a levantar el worker (`/slave-resume`).
- Timeout por tarea (`timeoutSec`) y timeout global opcional (`maxRunHours`).

Archivos recomendados de runtime:

```
.opencode-slave/runtime/
  worker.pid
  worker.state.json
  checkpoints/
    {task-name}.checkpoint.json
```

`worker.state.json` debe incluir:

- tareas activas
- progreso por tarea
- ultimo heartbeat global
- causa de parada (normal/error/manual)

---

## Contrato de salida por tarea

Cada tarea debe dejar `output/result.json`:

```json
{
  "status": "finished",
  "exitCode": 0,
  "durationSec": 145,
  "artifacts": [
    "output/patch.diff",
    "output/notes.md"
  ]
}
```

Esto facilita integracion con CI y dashboards.

---

## Integracion Git y politica de limpieza

Flujo recomendado en paralelo:

1. Crear worktree desde `baseBranch`.
2. Ejecutar tarea.
3. Si `autoCommit=true`, crear commit en `slave/{name}`.
4. Si `autoPR=true`, publicar branch y abrir PR con template.
5. Limpieza de worktree segun politica.

`cleanupPolicy` en config:

- `keep_on_changes` (default seguro): no elimina worktree si hay cambios sin commit.
- `stash`: hace stash y elimina worktree.
- `fail`: marca error y deja worktree intacto para inspeccion.

Nunca usar descarte forzado por defecto.

---

## Auto PR

`autoPR=true` requiere:

- Proveedor soportado (`github` inicialmente).
- CLI autenticado (`gh auth status` OK).
- Branch remoto publicado.

Template sugerido: `.opencode-slave/templates/pr.md`.

Si no hay autenticacion, no rompe tarea: deja warning y mantiene estado `finished` con nota.

---

## Logs y secretos

- Log principal: `.opencode-slave/logs/scheduler.log`
- Log por tarea: `.opencode-slave/tasks/{name}/logs/execution.log`

Medidas:

- Redaccion de secretos comunes (tokens, API keys, passwords).
- `maxLogSizeMb` con rotacion.
- Opcion `storeRawLogs=false` para entornos sensibles.

---

## Archivo de configuracion (`config.json`)

```json
{
  "schemaVersion": 1,
  "baseBranch": "main",
  "autonomyMode": "high",
  "maxParallel": 2,
  "defaultMaxRetries": 3,
  "defaultInvestigationBudget": 8,
  "requireResearchSummary": true,
  "dbIntrospectionMode": "auto",
  "maxRunHours": 8,
  "defaultTimeoutSec": 1800,
  "heartbeatSec": 15,
  "leaseTtlSec": 60,
  "worktreeBasePath": "../",
  "branchPrefix": "slave/",
  "autoCommit": false,
  "autoPR": false,
  "prProvider": "github",
  "gitStrategy": "rebase",
  "cleanupPolicy": "keep_on_changes",
  "securityMode": "untrusted",
  "logLevel": "info",
  "maxLogSizeMb": 5,
  "storeRawLogs": false
}
```

Campos importantes:

- `securityMode`: `untrusted` bloquea hooks y comandos peligrosos por defecto.
- `gitStrategy`: `rebase | merge | squash` para integracion final.
- `schemaVersion`: habilita migraciones futuras sin romper compatibilidad.
- `autonomyMode`: `high` obliga investigacion previa y minimiza escalado humano.
- `dbIntrospectionMode`: `off | auto | required` para consulta de DB segun tipo de tarea.
- `requireResearchSummary`: exige evidencia de investigacion antes de `finished`.

---

## Seguridad

Modo `untrusted` (default):

- No ejecuta hooks automaticamente.
- Exige allowlist de comandos.
- Bloquea operaciones destructivas por defecto.

Modo `trusted`:

- Permite hooks y comandos segun politicas del repo.

Bloqueos que SI permiten escalar a humano:

- Falta de credenciales o acceso a sistemas.
- Ambiguedad de negocio que cambia comportamiento funcional.
- Riesgo de accion destructiva sin confirmacion explicita.

Todo lo demas debe resolverse de forma autonoma con investigacion y reintentos.

---

## Flujo de ejecucion paralela (resumen)

```
/slave-start --parallel
       |
       v
adquiere lock + valida grafo
       |
       v
selecciona tareas elegibles (sin bloqueos)
       |
       +--> task-a (worktree slave/task-a)
       |
       +--> task-b (worktree slave/task-b)
       |
       v
actualiza heartbeat + estado + logs
       |
       v
libera lock + desbloquea siguientes tareas
```

---

## Restricciones conocidas de git worktrees

- No se puede usar la misma rama en dos worktrees al mismo tiempo.
- Hooks y config git son compartidos entre worktrees.
- Submodules requieren init por worktree.
- Aun siendo ligeros, cada worktree replica archivos del working tree.

---

## Checklist minimo de implementacion

1. Parser y validacion de `config.json` y `tasks.json` con schema versionado.
2. Lock robusto + escritura atomica.
3. Scheduler determinista + deteccion de ciclos.
4. Ejecutor con timeout, retries, heartbeat y lease.
5. Worktrees con base branch explicita.
6. Comandos de recovery: `validate`, `resume`, `prune-worktrees`, `dry-run`.
7. Logs seguros con redaccion y rotacion.
