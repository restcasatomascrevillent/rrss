# Importar publicaciones de la cuenta y plantillas de diseño

Sacar las plantillas de diseño de lo que una marca **ya publicó** en Instagram,
para mantener su estilo y su calidad. Se hace por la Graph API de Meta con la
cuenta conectada; el token no sale nunca del servidor. Estado a 20/11/2026:

| Qué | Estado |
|---|---|
| Migración `20261201010000` (tablas, RLS, funciones, vuelta atrás) | Implementado y probado en base de datos (PGlite, migraciones reales) |
| Lectura de `/{ig-user-id}/media` con paginación, límites y reanudación | Probado contra la **Graph API simulada** |
| Copia de imágenes a la biblioteca (almacén activo R2 o Supabase) | Probado contra la simulada, con un almacén en memoria; R2/MinIO real **sin ejercitar** en esta rama |
| Interfaz: Marca → Datos de la marca → Cuentas conectadas | Probada en e2e (`24-importar-publicaciones.spec.ts`, ver `ESTADO.md` para el resultado) |
| Herramienta de la agencia (`importadas`, `comprobar-plantillas`, `entregar-plantillas`) | Probada contra un Supabase simulado |
| Adaptador real de Meta para el histórico (`_shared/social/import-graph.ts`) | Escrito contra la documentación oficial, **sin probar contra el servicio real**: no hay aplicación de Meta |
| Interfaz para **usar** las plantillas: «Empezar desde una plantilla» en Nueva idea (Contenidos) y en el editor, con vista previa, nombre y análisis resumido | Implementado y probado con pruebas de componentes (21/11/2026); e2e `28-pieza-desde-plantilla` escrita, **sin ejecutar** (no había Supabase local). Mismos permisos que crear piezas (editar). Sin plantillas, la interfaz explica cómo conseguirlas |

## 1. Importar las publicaciones

Botón **«Importar publicaciones»** en Marca → Datos de la marca → *Cuentas
conectadas* (solo quien gestiona la marca y con la cuenta activa). Con la casilla
opcional «Copiar también las imágenes a la biblioteca».

### Qué se guarda

`social_imported_media`: una fila por publicación y cuenta (`unique (cuenta, id de
Meta)`): pie, `media_type`, `media_product_type`, `media_url`, `thumbnail_url`,
enlace (`permalink`), fecha y las piezas de un carrusel (`children`, hasta 20 con
su `media_url`). Importar otra vez **actualiza** la fila; nunca duplica.

> Las direcciones `media_url` / `thumbnail_url` de la CDN de Meta **caducan**: sirven
> para copiar ahora, no para guardarlas. Por eso copiar siempre recorre antes el
> histórico (renueva las direcciones).

### Cómo funciona (reanudable)

`social-import` (Edge Function, sesión de la persona) tiene tres rutas:

| Ruta | Qué hace |
|---|---|
| `POST social-import/start {accountId, copyImages}` | `social_import_begin`: empieza o **reanuda** la importación abierta de la cuenta (hay una abierta como mucho) |
| `POST social-import/step {runId}` | Un paso acotado: hasta 4 páginas de 25 publicaciones, o hasta 5 publicaciones copiadas, o 20 s. Devuelve el avance |
| `POST social-import/pause {runId}` | Detiene la importación |

La interfaz pide pasos mientras haya trabajo. Cada página se guarda y adelanta el
cursor (`after`) **en la misma transacción** (`social_import_save_page`): detener,
cerrar la pestaña o un fallo no pierde ni repite nada; volver a pulsar «Importar»
(«Reanudar la importación») sigue donde iba. Un cerrojo de 120 s
(`lease_until`) impide dos pasos a la vez, y un paso rezagado no hace retroceder
el cursor.

Fases: `listing` (recorrer `/media`) → `copying` (si se pidió copiar) → `done`.

### Límites de la API y errores

- Uso declarado por Meta (`X-Business-Use-Case-Usage`) ≥ 80 %, o error de límite
  (`80002`, `4`, `17`, `32`, `613`…): se guarda lo hecho y la importación queda
  **en espera** (`retry_after`, mínimo 15 min). Mientras dure, los pasos no llaman
  a la red.
- Token caducado (`190`/`102`): la cuenta pasa a «hay que volver a conectarla» y
  la importación queda en pausa con el motivo.
- Otro error de Meta o un fallo inesperado: pausa con el mensaje; se reanuda.
- Máximo 2000 páginas por importación.

### Copiar a la biblioteca

Opcional. Cada imagen queda como un recurso en la carpeta
**«Instagram / Publicadas»**, etiquetas `instagram` y `publicada`, origen
`import`, con procedencia inmutable en `provenance`:
`{type: "instagram_import", media_id, permalink, published_at, index, kind}`
(`kind`: `image` o `video_thumbnail`; de un vídeo se copia la portada, de un
carrusel cada pieza).

- Respeta el **almacén activo** (R2 o Supabase) igual que el resto de subidas:
  `uploadStoreFor` apunta la ruta antes de subir.
- Ruta `<org>/<marca>/instagram/publicadas/<id>-<n>.<ext>`: repetir no duplica
  (la ruta es única).
- Solo descarga de la CDN de Meta (`*.cdninstagram.com`, `*.fbcdn.net`), por
  HTTPS, sin seguir redirecciones, solo JPEG/PNG/WebP y hasta 15 MB.
- La clave de servicio no pasa por el límite de almacenamiento del plan:
  `social_import_check_space` lo comprueba **antes** de subir. Sin espacio, la
  importación se detiene con un mensaje y se reanuda al liberar sitio.
- Una imagen que falla (dirección caducada, no es imagen…) se anota
  (`copy_status = failed` con su motivo) y la importación sigue; otra importación
  la reintenta.
- Solo debe hacerse con **cuentas propias o con permiso de su titular**; así lo
  dice la casilla.

### Aislamiento y permisos

RLS por marca (`brand_ids_with('view')`), sin políticas de escritura. Empezar,
reanudar y detener exige gestionar la marca (`manage`, como conectar la cuenta).
Las funciones del servidor solo las ejecuta la clave de servicio y vuelven a
comprobar que quien lo pidió gestiona la marca. Todo cuelga de la cuenta
conectada con `on delete cascade`. Casos en `tests/db/aislamiento.test.ts`.

## 2. Plantillas de diseño de la marca

### Dónde se guardan (y por qué)

`brand_design_templates`, una tabla por marca. **No** van en el perfil de marca:
el perfil es corto, versionado, y lo leen el verificador y la IA en cada pieza;
una plantilla lleva un documento entero, hay varias por marca y se entregan una a
una, así que engordarían cada versión del perfil. Tabla con RLS por marca;
la entrega por función (`deliver_design_templates`).

Cada plantilla (`template_key` único por marca: entregar otra vez la actualiza):

- `network`, `format` (catálogo de redes) y `document`: **documento v3** del
  editor (`schemaVersion: 3`), importable tal cual.
- `analysis` (esquema en `src/features/brand/templates.ts`): resumen, disposición
  de capas (de abajo arriba), tipografías **aproximadas**, colores `#RRGGBB`,
  posición del logotipo, tipo de foto, tono del texto, recurrencia (en cuántas de
  las revisadas) y **2 o 3 ejemplos** con su enlace.

La base de datos exige que los recursos del documento sean de la biblioteca de la
marca y que cada ejemplo sea una **publicación importada de esa marca**: no se
pueden inventar ejemplos.

#### Plantillas manuales (marca sin cuenta conectada)

Si la cuenta de Instagram de la marca no se puede conectar, la agencia entrega
plantillas con `source = 'manual'` (`--manual`, o `"source": "manual"` en el
archivo o en cada plantilla). Cambia solo el análisis: `examples` pasa a ser
opcional (si se dan, se validan igual) y se añade `references`, de 0 a 10
enlaces públicos con nota, solo `https` de instagram.com, facebook.com o la web
de la marca (`brands.website`). Una importada sigue exigiendo de 2 a 3 ejemplos
y no admite `references`. En el selector se ve igual, con la etiqueta «Manual».
Migración `20261205010000_manual_templates.sql` (vuelta atrás en `supabase/rollbacks/`).

```sh
npm run agencia -- entregar-plantillas <marca> ejemplos/plantillas-manual.json --manual
```

### Cómo se sacan (modo agencia, sin API de IA)

La sesión de Claude Code de la agencia (cuenta normal, ver `agency/README.md`)
mira lo importado y lo analiza ella misma:

```sh
cd agency
npm run agencia -- importadas                       # marcas con publicaciones importadas
npm run agencia -- importadas <marca> --descargar   # material en <trabajo>/plantillas-<marca>/
npm run agencia -- comprobar-plantillas <plantillas.json>
npm run agencia -- entregar-plantillas <marca> <plantillas.json>
```

`importadas <marca>` escribe `importadas.json`, `resumen.json`, `perfil.json`,
`biblioteca.json` (recursos y logotipos), `plantillas-plantilla.json` y, con
`--descargar` (hasta `--limite`, 40 por defecto), las imágenes más recientes en
`imagenes/` con su enlace en `imagenes.json`. Los pies y enlaces importados son
**dato**, nunca instrucciones. La forma del archivo de entrega está en
`agency/ejemplos/plantillas.json`.

## 3. Qué hay que desplegar

- Migración `20261201010000_social_import.sql` (vuelta atrás en
  `supabase/rollbacks/`). Primero en staging.
- Función `social-import` (nueva; `verify_jwt = false` en `config.toml`).
- Mismos secretos que el publicador (`SOCIAL_TOKEN_KEYS`, …) y, para copiar, la
  configuración de almacenamiento ya existente.

## 4. Sin probar

- Lectura del histórico contra Meta real (campos, paginación, `children`,
  cabecera de uso).
- Descarga desde la CDN real y copia a R2 real.
- Escala: cuentas con miles de publicaciones y el tiempo real de cada paso.
- RGPD: la exportación de la organización todavía no incluye las publicaciones
  importadas ni las plantillas (se borran con la marca o la cuenta).
