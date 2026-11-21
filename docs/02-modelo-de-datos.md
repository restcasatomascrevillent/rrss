# Modelo de datos y multi-tenancy

Fuente de verdad: `supabase/migrations/`. Este documento explica el porqué.

## 1. Lo que existe (Fase 1)

```
auth.users ──1:1── profiles
     │
     ├── platform_admins                    superadministradores (alta manual)
     │
organizations ──< organization_members >── auth.users        rol: owner | admin | member
     │
     ├──< invitations                       token de un solo uso (solo se guarda su huella)
     ├──< audit_logs                        quién hizo qué (sin FK: sobrevive a lo auditado)
     │
     └──< brands ──< brand_members >── organization_members   rol: manager | editor | reviewer | client | viewer
              │
              ├──< brand_profiles           perfil de marca versionado (una versión vigente)
              ├──< brand_knowledge_sources  manual, documentos, web
              └──< media_assets             biblioteca
```

| Tabla | Para qué | Cómo se escribe |
|---|---|---|
| `profiles` | Nombre, correo e idioma de cada usuario | La crea un disparador al registrarse; cada uno edita la suya |
| `platform_admins` | Quién administra la plataforma | Solo con la clave de servicio |
| `organizations` | Empresa o agencia | `create_organization()`; los administradores editan nombre y ajustes |
| `organization_members` | Pertenencia y rol | Solo por RPC: `accept_invitation`, `set_member_role`, `remove_member` |
| `brands` | Marca gestionada | Insertan los administradores; edita quien gestiona la marca; se archivan, no se borran |
| `brand_members` | Rol de un miembro en una marca | Quien gestiona la marca |
| `brand_profiles` | Identidad, voz, público, reglas | Solo `save_brand_profile()`: cada guardado es una versión nueva |
| `brand_knowledge_sources` | Material del que aprende la IA | Quien gestiona la marca |
| `media_assets` | Fotos, vídeos, logotipos, documentos | Quien edita la marca |
| `invitations` | Altas pendientes | `create_invitation`, `revoke_invitation` |
| `audit_logs` | Registro de actividad | Solo disparadores |

## 2. Cómo se garantiza el aislamiento

1. **RLS en todas las tablas.** Una prueba falla si aparece una tabla sin RLS o
   sin estar cubierta por las pruebas de aislamiento.
2. **`anon` no tiene nada**: ni tablas ni funciones.
3. **Privilegios por columna.** El cliente no puede, por ejemplo, cambiar el
   `organization_id` de una marca ni el correo de un perfil, aunque la política
   de fila se lo permitiera.
4. **Claves foráneas compuestas** `(brand_id, organization_id)`: un recurso no
   puede declararse de una organización distinta a la de su marca.
5. **Rutas de almacenamiento verificadas**: `<organization_id>/<brand_id>/…`. La
   política extrae la marca de la ruta y comprueba que pertenece a esa
   organización y que el usuario tiene permiso. La tabla exige además que la
   ruta guardada empiece por esos dos identificadores.
6. **Privilegios por defecto cerrados**: una tabla o función nueva nace sin
   acceso; cada migración debe conceder lo que necesite.

## 3. Matriz de permisos por rol de marca

Definida en un único sitio: `private.brand_role_grants`.

| Capacidad | manager | editor | reviewer | client | viewer |
|---|---|---|---|---|---|
| `view` ver | ✓ | ✓ | ✓ | ✓ | ✓ |
| `comment` comentar | ✓ | ✓ | ✓ | ✓ | — |
| `approve` aprobar | ✓ | — | ✓ | ✓ | — |
| `edit` crear y editar | ✓ | ✓ | — | — | — |
| `manage` configurar marca y equipo | ✓ | — | — | — | — |

Los `owner` y `admin` de la organización actúan como `manager` de todas sus
marcas. Un `member` solo ve las marcas donde tiene rol.

Reglas de organización: solo un propietario nombra o toca a otro propietario;
una organización nunca se queda sin propietario; una invitación solo la acepta
la cuenta cuyo correo coincide, y nunca cambia el rol de quien ya era miembro.

## 4. Rendimiento de las políticas

Las políticas tienen la forma `brand_id in (select private.brand_ids_with('view'))`.
Postgres evalúa la subconsulta **una vez por sentencia**, no una vez por fila, y
las tablas tienen índice por `brand_id`. Es lo que permite listas de cientos de
miles de filas sin que la seguridad sea el cuello de botella.

Una función `STABLE` no ve lo que inserta su propia sentencia; por eso la
política de lectura de `brands` tiene una primera condición que no consulta
`brands` (necesaria para `INSERT … RETURNING`).

## 5. Perfil de marca

`brand_profiles.data` es un JSON validado en el cliente (`schema_version`) con:
negocio, público, objetivos, voz, identidad visual, canales, idiomas,
competidores, referencias y restricciones. `provenance` registra el origen de
cada sección (usuario, importación, IA) y si está verificada: la IA puede
proponer, pero **nada inferido se convierte en regla hasta que alguien lo valida**.

Se guarda como JSON versionado y no como columnas porque la forma del perfil va
a evolucionar con el producto; el número de versión del esquema permite migrar
perfiles antiguos sin migraciones de base de datos.

## 6. Configuración exportable

`{ format: "rrss.brand-config", version: 1, brand: {…}, profile: {…} }`. Sirve
para dar de alta marcas en bloque, hacer copias y mover una marca entre
entornos. No incluye archivos ni miembros.

## 7. Lo que se añadirá (diseño previsto, sin implementar)

| Fase | Entidades | Notas |
|---|---|---|
| 2 | `ai_models`, `knowledge_chunks` (vectores) | **Ya existen** `ai_generations`, `ai_usage`, `usage_quotas` y `jobs` (secciones 9 y 10), y `content_items` y `content_versions` (sección 11). `ai_models` (registro de modelos y precios como dato) espera a que se elija proveedor: hoy los modelos son configuración del servicio |
| 3 | `social_accounts`, `social_account_secrets` (cifrada, sin acceso desde el cliente), `campaigns`, `scheduled_publications`, `publication_attempts`, `approvals`, `comments` | El calendario es una vista de `scheduled_publications`, no una tabla. Una publicación programada apuntará a una pieza y a una versión concreta de `content_versions` (sección 11) |
| 4 | `automations`, `automation_runs`, `agent_runs`, `agent_steps` | Cada paso reanudable |
| 5 | `analytics_snapshots` (particionada por fecha) | Datos tal como los da cada red, con su procedencia |
| 6 | `plans`, `subscriptions`, `entitlements`, `feature_flags`, `notification_events` | Suscripción (Stripe), derechos y consumo, separados |

De la lista inicial del encargo se han fusionado o cambiado:

- `brand_guidelines` → es `brand_profiles` (el manual se convierte en perfil
  estructurado; el archivo original es una `brand_knowledge_source`).
- `organization_settings` → columna `settings` de `organizations` mientras sean
  pocos ajustes.
- `social_account_permissions` → los permisos van por marca (`brand_members`);
  una cuenta social pertenece a una marca.
- `media_asset_versions` y `content_variants` → llegarán con el editor, como
  versiones del documento.
- `editorial_calendars` → vista sobre las publicaciones programadas.
- `approval_workflows` → `approvals` por pieza; las reglas (quién debe aprobar)
  son configuración de la marca.

## 8. Reglas para nuevas migraciones

- Una migración por cambio, con su vuelta atrás en `supabase/rollbacks/`.
- Tabla nueva → RLS, políticas, privilegios explícitos y casos en
  `tests/db/aislamiento.test.ts` (la prueba de catálogo obliga).
- Función `SECURITY DEFINER` → `set search_path = ''` y nombres completos.
- Nada destructivo sin plan de recuperación aprobado.

## 9. Fase 2 (cimientos): consumo y cupos de IA

Implementado y probado en base de datos; **sin interfaz y sin proveedor real**.

```
organizations ──< usage_quotas            límite por organización y métrica
brands ──< ai_generations                 una fila por llamada a un proveedor
            ·····  ai_usage               libro de consumo (sin FK: sobrevive al borrado)
```

| Tabla | Para qué | Quién la lee | Cómo se escribe |
|---|---|---|---|
| `usage_quotas` | Cupo mensual de IA de la organización (`ai_cost_micros`) | Administradores de la organización | `admin_set_ai_quota()` (superadministrador, auditado) o la clave de servicio |
| `ai_generations` | Tarea, propósito, proveedor, modelo, consumo, coste, latencia, estado, error y resultado | Quien puede crear contenido en la marca (`edit`) | Solo las tres funciones de abajo |
| `ai_usage` | Libro de consumo de solo añadir | Administradores de la organización | Solo las tres funciones de abajo |

**Unidades.** Todos los importes son enteros en millonésimas («micros») de la
moneda de cuenta de la plataforma. La moneda es una sola y no se guarda: es una
decisión pendiente del dueño (ver `docs/ESTADO.md`).

**Ciclo de una generación** (lo ejecuta el servidor con la clave de servicio,
indicando en nombre de qué usuario):

1. `ai_reserve_generation(usuario, marca, tarea, propósito, proveedor, modelo,
   reserva, caducidad)` comprueba que el usuario puede crear contenido en la
   marca, **bloquea la fila del cupo** de la organización, devuelve las reservas
   caducadas, suma lo comprometido en el mes y, si la reserva cabe, crea la
   generación (`reserved`) y apunta `reserve +reserva`. Si no cabe falla con
   `AI001` y un mensaje para personas; sin cupo asignado, con `AI002`.
2. `ai_complete_generation(id, coste, consumo, resultado, latencia)` apunta
   `settle −reserva +coste` y la deja `succeeded`.
3. `ai_fail_generation(id, código, mensaje)` apunta `release −reserva` y la deja
   `failed`: **un fallo del proveedor no consume cupo**.

Decisiones que conviene conocer:

- **Cupo comprometido** del mes = suma de `reserved_delta_micros +
  cost_delta_micros` del libro. Las reservas en curso cuentan: por eso la
  reserva es una cota superior del coste, no una estimación optimista.
- **Simultaneidad.** El bloqueo de la fila de `usage_quotas` serializa las
  reservas de una organización; las de organizaciones distintas no se estorban.
- **Sin cupo asignado no se genera.** No hay cupo por defecto: lo fijará el plan
  (Fase 6) o un superadministrador.
- **Periodo**: mes natural en UTC. Una generación se imputa al mes en que se
  reservó.
- **Reservas huérfanas.** Si el servidor muere a media llamada, la reserva
  caduca (`expired`) y su cupo se devuelve en la siguiente reserva de esa
  organización, sin depender de un reloj. Si el proveedor acaba respondiendo
  tarde, el coste se apunta igualmente: el gasto es real.
- **El coste real puede superar la reserva** (el libro dice la verdad); lo que
  no puede es empezar otra generación sin saldo.
- **Ni la clave de servicio escribe a mano** `ai_generations` ni `ai_usage`:
  solo tiene `select`. Todo pasa por las funciones.
- **Coste por organización**: `ai_cost_by_organization(desde, hasta)` suma los
  apuntes `settle` del libro. Un administrador ve las organizaciones que
  administra; un superadministrador, todas (también las borradas, sin nombre).
  Para desgloses (por marca, por mes) los administradores consultan `ai_usage`.

Pendiente en este bloque: valoración del usuario por generación, clave de
idempotencia y caché de peticiones idénticas, modelo alternativo si falla,
registro de modelos como dato (`ai_models`) y cupos por métricas distintas del
coste.

## 10. Fase 2 (cimientos): cola de trabajos

Implementada y probada en base de datos; **todavía no hay ningún trabajador ni
ningún tipo de trabajo en uso**.

`jobs`: organización, marca (opcional), tipo (`kind`, texto libre), carga,
estado (`queued`, `running`, `succeeded`, `failed`, `cancelled`), prioridad,
clave de idempotencia (única por organización), intentos y máximo, `run_after`,
reserva (`locked_by`, `locked_until`), resultado y último error.

| Función (solo clave de servicio) | Qué hace |
|---|---|
| `enqueue_job` | Encola; con una clave ya usada devuelve el trabajo existente sin tocarlo |
| `claim_jobs(trabajador, tipos, límite, segundos)` | Reclama con `FOR UPDATE SKIP LOCKED` por prioridad y antigüedad; recoge también los trabajos en curso con la reserva caducada, y cierra como fallidos los caducados sin intentos |
| `complete_job` / `fail_job` | Solo quien tiene la reserva. Un fallo vuelve a la cola con espera creciente (30 s, 1 min, 2 min… hasta 1 h) y, agotados los intentos, queda `failed` con su error |
| `cancel_job` | Cancela un trabajo en cola o en curso |
| `release_job(trabajo, trabajador)` | Solo quien tiene la reserva. Devuelve el trabajo a la cola **sin gastar intento** y disponible ya (apagado ordenado del trabajador) |
| `extend_job_lease(trabajo, trabajador, segundos)` | Solo quien tiene la reserva. La renueva desde ahora (5 s a 1 h): el trabajador la va renovando en trabajos largos |

Lectura: los trabajos de una marca los ve quien ve la marca; los de toda la
organización, sus administradores. Nadie los escribe desde el cliente.

El trabajador de medios (`worker/`) consume esta cola: renueva la reserva
mientras trabaja y, al apagarse, devuelve lo que tiene a medias con
`release_job`.

Pendiente: alta en la publicación de Realtime (se hará en el entorno desplegado),
limpieza de trabajos antiguos y prioridad por plan.

## 11. Fase 2: contenidos y versiones

Implementado y probado en base de datos y en la capa de acceso a datos; **sin
pantallas, sin editor y sin render**. No hay nada de programación ni de
publicación: eso es la Fase 3.

```
brands ──< content_items ──< content_versions
            pieza              instantáneas inmutables del documento
```

| Tabla | Para qué | Quién la lee | Cómo se escribe |
|---|---|---|---|
| `content_items` | Una publicación de una marca: nombre interno, red y formato de destino, estado, número de la versión vigente, archivado y autor | Quien ve la marca (`view`) | Quien edita (`edit`) la crea y cambia su nombre, red y formato. El estado, la versión vigente y el archivado solo cambian por función |
| `content_versions` | El documento de la pieza en cada guardado: número, versión del esquema, documento (`data`), nota, autor y, si es una restauración, de qué versión se copió | Quien ve la marca | Solo `save_content_version()` y `restore_content_version()`. Nadie las cambia ni las borra, tampoco con la clave de servicio |

| Función | Quién | Qué hace |
|---|---|---|
| `save_content_version(pieza, documento, versión del esquema, nota, versión esperada)` | `edit` | Guarda una versión nueva (la vigente + 1) |
| `restore_content_version(pieza, versión, nota, versión esperada)` | `edit` | Copia el documento de una versión antigua en una versión nueva; el historial no se toca |
| `set_content_status(pieza, estado, versión esperada)` | `edit` o `approve`, según el cambio | Cambia el estado |
| `archive_content_item(pieza, archivar)` | `edit` | Archiva o recupera; no se borra nada |

**Estados**: `idea` → `draft` → `in_review` → `approved`. El estado termina en
«aprobada» a propósito: «programada» y «publicada» no son estados de la pieza
sino hechos de la Fase 3 (`scheduled_publications`, `publication_attempts`).

- Quien edita mueve la pieza entre idea, borrador y revisión, y puede retirar
  una aprobación. Una idea puede no tener documento; para pasar a revisión hace
  falta al menos una versión guardada.
- Aprobar exige la capacidad `approve` (gestor, revisor, cliente), que la pieza
  esté en revisión —o en borrador si quien aprueba también edita— y **decir qué
  versión se aprueba**.
- Quien solo aprueba puede devolver a borrador lo que está en revisión o
  aprobado, y nada más.
- **Una aprobación vale para la versión que se aprobó**: guardar o restaurar
  otra versión, o cambiar la red o el formato, devuelve la pieza a borrador.
  Así, «aprobada» significa siempre «la versión vigente está aprobada».
- Guardar el primer documento de una idea la pasa a borrador.

**Guardado sin pisar a nadie.** No hay edición simultánea. Quien guarda, restaura
o aprueba puede indicar sobre qué versión trabajaba; si otra persona guardó
después, la función falla con el código `CT001` (y las cifras en `DETAIL`) y no
escribe nada. La fila de la pieza se bloquea durante el guardado, así que dos
guardados a la vez no pueden repetir número.

**Archivar.** `archived_at` marca la pieza como archivada sin perder su estado.
Una pieza archivada se sigue viendo, con su historial, pero no admite ningún
cambio hasta recuperarla. Los contenidos no se borran desde el cliente; solo
desaparecen en cascada al borrar la marca.

**El documento** es un JSON validado en el cliente, igual que el perfil de
marca (sección 5): formato propio por capas, independiente del editor, con
`schemaVersion` y migraciones al leer (`src/features/content/document/`). La
base de datos solo exige que sea un objeto de menos de 512 KB y guarda aparte
su versión de esquema. La columna se llama `data`, como en `brand_profiles`,
porque el registro de auditoría no copia esa columna.

**Red y formato** son texto con forma de identificador (`instagram`, `reel`…).
Qué redes y formatos existen, con sus medidas y límites y la procedencia de cada
cifra, es un catálogo de la aplicación (`src/features/content/networks.ts`), no
de la base de datos: añadir una red no pide migración.

**Auditoría.** De la pieza se registran el alta, el borrado y los cambios de
nombre, red, formato, estado y archivado; de cada versión, el alta, sin el
documento. El avance del número de versión no genera un apunte propio.

**Previsto para la Fase 3, sin simular nada.** No hay columnas de fecha de
publicación ni estados de programada o publicada. Lo que queda preparado son
las dos claves únicas a las que apuntarán las publicaciones programadas:
`content_items (id, brand_id, organization_id)` y `content_versions
(content_id, version)`. Una publicación podrá así fijar la pieza y la versión
exacta que se aprobó, y comprobar al publicar que sigue siendo la vigente y que
la pieza sigue aprobada.

Pendiente en este bloque: enlazar las variantes de una misma idea para varias
redes (hoy cada red es una pieza distinta, que se obtiene adaptando el
documento), comentarios y registro de aprobaciones por pieza (Fase 3), y
recursos generados o exportados asociados a una versión (llegan con el render).

## 12. Modo agencia: encargos

Implementado y probado en base de datos, en la interfaz (componentes) y en la
herramienta de la agencia (`agency/`, contra un Supabase simulado), y de extremo
a extremo contra el Supabase local (`tests/e2e/12-…`, 18/11/2026).

```
brands ──< content_requests ──< content_request_comments
              │  encargo            conversación e historial de estados
              └── content_items (pieza entregada, en borrador)
```

| Tabla | Para qué | Quién la lee | Cómo se escribe |
|---|---|---|---|
| `content_requests` | Encargo: título, texto del cliente, red y formato del catálogo, tipo de medio, recursos de la biblioteca de referencia, fecha deseada, estado, pieza y versión entregadas, cerrojo | Quien ve la marca | Solo funciones |
| `content_request_comments` | Cada comentario y cada cambio de estado, con autor y fecha | Quien ve la marca | Solo funciones |

`brands.ai_mode` (`api` por defecto, o `agency`) dice cómo se redacta con IA en
la marca; lo cambia quien la gestiona.

**Estados**: `requested` → `in_progress` → `delivered` → (`changes_requested` →
`in_progress` → `delivered`)… → `accepted`, o `cancelled`.

| Función | Capacidad | Qué hace |
|---|---|---|
| `create_content_request` | `comment` | Pide un encargo (también el cliente). Los recursos tienen que ser de la marca; con `p_content_id`, el encargo es sobre una pieza existente (como mucho un encargo abierto por pieza) |
| `comment_content_request` | `comment` | Comenta |
| `pending_content_requests` | `edit` | Cola de quien prepara: pedidos, con cambios pedidos y en curso con el cerrojo caducado o propio |
| `take_content_request(id, clave, minutos)` | `edit` | Toma el encargo. Cerrojo con clave de sesión y caducidad (5 min a 24 h, 4 h por defecto): mientras no caduque, nadie más —ni otra sesión de la misma cuenta— lo toma ni lo entrega (`RQ001`) |
| `release_content_request` | `edit` | Lo devuelve a la cola |
| `deliver_content_request(id, documento, versión del esquema, clave, título, nota)` | `edit` | En una transacción: crea la pieza (o añade una versión a la enlazada) **en borrador**, la enlaza, apunta la versión entregada y marca el encargo como entregado |
| `request_content_request_changes(id, mensaje)` | `approve` | Pide cambios sobre lo entregado (mensaje obligatorio) |
| `accept_content_request` | `approve` | Acepta y **aprueba la pieza en la versión entregada**; si la pieza tiene una versión posterior, falla (`RQ002`) |
| `cancel_content_request` | quien lo pidió, o `manage` | Cancela un encargo abierto |

Decisiones que conviene conocer:

- **Aceptar aprueba la pieza** aunque esté en borrador y quien acepta no pueda
  editar: la entrega hace de envío a revisión. Es la misma regla de siempre
  («una aprobación vale para la versión que se aprobó»), aplicada a la versión
  entregada.
- **El lector (`viewer`) ve los encargos pero no pide ni comenta**: «pedir»
  usa la capacidad `comment`, que el lector no tiene.
- **La agencia es un usuario normal**: una cuenta miembro de la organización del
  cliente con rol `editor` en las marcas que gestiona. No puede aprobar ni
  aceptar, y la herramienta entra con su correo y contraseña y la clave pública,
  nunca con la clave de servicio.
- **El texto del encargo y de los comentarios es dato**: la herramienta lo
  entrega a la sesión de Claude con ese aviso (`agency/INSTRUCCIONES.md`).
- **Auditoría**: alta, cambios de estado o de pieza y borrado del encargo; alta
  de cada comentario.

## 13. Texto de las fuentes y tipografías de la marca

Migraciones `20261119210000_source_text_extraction` y `20261119211000_brand_fonts`.

**Texto de las fuentes.** `brand_knowledge_sources` guarda ahora el texto
extraído (`extracted_text`, hasta 200 000 caracteres; el trabajador recorta a
100 000), su longitud, el detalle (`extraction`: páginas, páginas web leídas u
omitidas, recorte), la fecha y el último trabajo (`extraction_job_id`). Lo
extrae el trabajador de medios (`source.extract`, sin IA; detalle en
`worker/README.md`):

- Al dar de alta una fuente, un disparador encola su extracción. De imágenes y
  presentaciones no se extrae: la fuente queda fallida con el motivo.
- Un disparador sobre `jobs` lleva el estado a la fuente (`pending` →
  `processing` → `ready` o `failed` con el motivo en `error`; un reintento la
  deja `pending` con «Se reintentará: …») y **mueve** el texto del resultado a
  la fuente antes de guardar el trabajo. Solo cuenta el último trabajo de cada
  fuente.
- `request_source_extraction(fuente)`: volver a pedirla (quien gestiona la
  marca; si ya hay una en marcha devuelve esa; 20 a la vez por marca).
- El cliente no puede escribir el texto ni el estado (sin permiso de UPDATE).
  La lista de fuentes no pide el texto; se lee al revisarlo o al proponer el
  perfil, que usa todas las fuentes listas, las más recientes primero hasta
  los topes (20 fuentes, 400 000 caracteres).

**Tipografías.** `brand_fonts`: una fila por archivo (.woff2, .woff, .ttf,
.otf) con familia, peso (100–900), estilo, 5 MB como mucho, ruta en
`<organización>/<marca>/fonts/` y `license_confirmed` obligatorio (quien la
sube declara que la marca puede usarla; la aplicación no lo comprueba). La ven
quienes ven la marca; la suben y borran quienes la gestionan; no se edita. El
cubo admite `font/woff2`, `font/woff`, `font/ttf` y `font/otf`.

Reels: al encolar un `media.reel.template` con textos, un disparador pone
`plan.fontPath` con el .ttf/.otf de la marca (familia primera del perfil,
redonda, peso cercano a 400); `brand_reel_font_info(marca)` dice cuál será.
Sin archivo .ttf/.otf, el trabajador usa su tipografía de reserva y la
aplicación lo dice.

## 13. Fase 3: publicación

Implementado y probado en base de datos, con el publicador y la conexión contra
una Graph API simulada (detalle, garantías y lo que falta de Meta en
`docs/publicacion.md`).

```
brands ──< social_accounts ──1:1── private.social_account_secrets   (tokens cifrados)
   │
   └──< content_items ──< scheduled_publications ──< publication_attempts
                │                 (pieza + versión aprobada + recursos + cuenta)
                └──< content_comments   (comentarios y hechos de aprobación)

## 13. Fase 6: planes, suscripciones y límites

Implementado y probado en base de datos (migración `20261119310000_plans_subscriptions`).
Detalle de uso, Stripe y variables en `docs/facturacion.md`.

```
plans ──< subscriptions >── organizations    una suscripción por organización (se crea sola)
          ·····  billing_events               avisos de Stripe recibidos (sin FK)
```

| Tabla | Para qué | Quién la lee | Cómo se escribe |
|---|---|---|---|
| `social_accounts` | Cuenta conectada de una marca y red: identificador, nombre, estado, caducidad del token, cupo | Quien ve la marca | El servidor al conectar; `disconnect_social_account` (`manage`) |
| `private.social_account_secrets` | Tokens cifrados (AES-256-GCM en la función) | Nadie del cliente; el servidor con `social_account_token` | Solo el servidor |
| `private.social_oauth_states` | Estado anti-CSRF del OAuth (huella, 10 minutos, un uso) | Nadie del cliente | `social_oauth_begin` (`manage`) y `social_oauth_consume` (servidor) |
| `scheduled_publications` | El calendario: pieza, versión, cuenta, recursos, fecha, estado (`planned` → `scheduled` → `publishing` → `published`, o `failed`/`cancelled`), contenedor e identificador de la red | Quien ve la marca | `save_publication`, `reschedule_publication`, `cancel_publication`, `retry_publication` (`edit`); el publicador con sus funciones |
| `publication_attempts` | Cada pasada del publicador con su resultado | Quien ve la marca | Solo el publicador |
| `content_comments` | Comentarios de la pieza y hechos de aprobación | Quien ve la marca | `comment_content_item` (`comment`), `request_content_changes` (`approve`), un disparador al aprobar |

`approve_content_items` aprueba por lotes con las reglas de `set_content_status`.
La regla dura (lo no aprobado en la versión programada no se publica) vive en
`private.publication_hold_reason`, que usan el disparador que reevalúa el
calendario, la guarda que impide pasar a `publishing` y el publicador.

| `plans` | Precio, periodo, cuotas (marcas, personas, almacenamiento, cupo de IA) y funciones | Cualquiera con sesión (los activos); el superadministrador, todos | Superadministrador, directamente (RLS + columnas); `is_default` con `admin_set_default_plan` |
| `subscriptions` | Plan asignado, origen (`default`, `manual`, `stripe`), estado, precio pactado, ids de Stripe | Administradores de la organización y superadministradores | `admin_set_organization_plan` o `billing_apply_stripe_event` (clave de servicio); auditada |
| `billing_events` | Idempotencia y rastro de los avisos de Stripe | Superadministradores | `billing_apply_stripe_event` |

- **Plan efectivo** (`private.org_plan`): el de la suscripción si está vigente
  (`active`, `trialing`, `past_due`), si no el plan por defecto.
- **Límites** con disparadores (marcas, miembros, invitaciones, archivos, encargos
  de medios) y en `ai_reserve_generation`. Errores `PL001` (límite) y `PL002`
  (función no incluida). Los disparadores son `SECURITY INVOKER` para saber qué
  rol escribe; las comprobaciones (`private.check_*`) son `SECURITY DEFINER`.
- **Cupo de IA** = el sobrescrito en `usage_quotas` o, si no hay, el del plan.
  `ai_reserve_generation` bloquea ahora la fila de `subscriptions` (sustituye al
  bloqueo de `usage_quotas` de la sección 9).
- **Margen**: `admin_billing_overview(primer día del mes)` → ingresos del plan
  llevados a un mes, coste de IA del mes y margen por organización.
- **Organizaciones anteriores** a esta migración: plan «Heredado» (sin límites).

## 13. Fase 4: campañas (plan por instrucción → borradores)

Migración `20261119510000_campaigns` (vuelta atrás en `supabase/rollbacks/`).
Patrón «la IA propone un plan y un motor determinista lo ejecuta»: el plan es
solo datos y el único actor es el motor, que solo sabe **crear borradores**.

| Tabla | Qué guarda |
|---|---|
| `campaigns` | Marca, nombre, instrucción (dato), redes, fechas (1–63 días), origen (`ai` o `agency`), estado (`requested` → `proposed` → `accepted` o `discarded`), versión vigente y aceptada del plan |
| `campaign_plans` | Cada versión del plan, inmutable y numerada, en `data` (la auditoría no la copia): `ai` (la IA, con su `generation_id`), `agency` (la agencia) o `edit` (retocado por una persona al aceptar) |
| `campaign_contents` | Qué piezas creó el motor, de qué versión y posición del plan |

`content_requests` gana `kind` (`piece` | `plan`), `campaign_id` y
`delivered_plan_version`. La regla «entregado ⇒ pieza y versión» vale solo
para `piece`; un encargo de plan nunca tiene pieza (un disparador lo impide) y
cancelarlo descarta su campaña.

Funciones (todas `security definer`, `search_path = ''`):

| Función | Quién | Qué hace |
|---|---|---|
| `create_campaign` | `edit` | Guarda la campaña con el plan de una generación `campaign.plan` de esa marca y de esa persona, terminada bien. Queda «por revisar» |
| `request_campaign_plan` | `comment`, marca en modo agencia | Campaña sin plan y encargo de tipo `plan` para la agencia |
| `deliver_campaign_plan` | `edit`, con el encargo tomado (cerrojo) | Versión nueva del plan (`agency`); encargo entregado |
| `accept_campaign_plan` | `edit` (o `approve` si el plan es de la agencia) | **El motor.** Comprueba la versión revisada (`CP001` si cambió), valida el plan y un documento por pieza (forma cerrada, redes de la campaña, fechas dentro, recursos de la marca, texto del documento = texto de la pieza) y crea cada pieza en **borrador** con su versión 1. Todo o nada. Nunca aprueba, programa ni publica |
| `discard_campaign` | igual que aceptar | Descarta sin crear nada; cancela el encargo abierto |

La forma del plan (`private.campaign_plan_problem`) es la misma que
`src/features/campaigns/plan.ts` y que la salida de la tarea `campaign.plan`:
`objective`, `summary`, `reasoning {observed, dataBacked, hypotheses, dataNote}`
y `pieces[] {network, format, date, idea, caption, hashtags, assetIds, why}`.
Un campo de más invalida el plan entero.

RLS: las tres tablas las ve quien ve la marca; no hay políticas ni privilegios
de escritura (solo las funciones). Casos en `tests/db/aislamiento.test.ts` y
`tests/db/campanas.test.ts`.

## 13. RGPD: aceptaciones, exportar y borrar

Implementado y probado en base de datos (`tests/db/aislamiento.test.ts`,
`tests/db/rgpd.test.ts`) y en la interfaz; el escenario de extremo a extremo
(`tests/e2e/14-…`) está escrito y sin ejecutar. Detalle y decisiones en
`docs/rgpd.md`. Esto no es asesoría legal.

| Tabla / columna | Para qué | Quién la lee | Cómo se escribe |
|---|---|---|---|
| `legal_acceptances` | Versión y fecha en que cada persona aceptó las condiciones y la política de privacidad | Cada persona, las suyas | Un disparador al registrarse (versiones en los metadatos del alta) y `accept_legal_documents` |
| `content_versions.ai_generated`, `content_items.ai_generated` | La versión (y la pieza, por su versión vigente) lleva contenido generado con IA | Quien ve la marca | Solo la base de datos, al insertar cada versión |

| Función | Quién | Qué hace |
|---|---|---|
| `export_my_data()` | Cualquiera con sesión | Sus datos personales en JSON; sin parámetros |
| `export_organization_data(org)` | Propietarios | Datos de la organización en JSON (`SECURITY INVOKER`: la RLS sigue mandando) |
| `my_account_deletion_check()` | Cualquiera con sesión | Qué organizaciones impiden borrar la cuenta y cuáles se borrarían con ella |
| `gdpr_delete_account_data(usuario)` | Solo clave de servicio (`delete-account`) | Comprueba que no deja organizaciones con miembros sin propietario (RG001) y borra las suyas sin más miembros |
| `gdpr_delete_organization(usuario, org, confirmación)` | Solo clave de servicio (`delete-organization`) | Propietario (42501) y nombre exacto (RG002); borra la organización y devuelve sus rutas de Storage |
| `gdpr_forget_storage_paths(rutas)` | Solo clave de servicio | Quita de `storage_cleanup_queue` lo que ya se borró de Storage |

Al borrar un usuario de `auth.users` (por la función o a mano), los
disparadores `on_auth_user_deleting` y `zz_on_auth_user_deleted` lo sacan de
sus organizaciones (si es el único propietario de una, `keep_one_owner` lo
impide), anonimizan las invitaciones que aceptó y quitan su id y su correo del
registro de auditoría. Las demás autorías pasan a null por sus claves foráneas.
