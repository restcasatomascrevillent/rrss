# Herramienta de la agencia (`agency/`)

Línea de órdenes con la que una **sesión de Claude Code de la agencia** atiende
los encargos de las marcas que gestiona: ve la cola, toma un encargo, descarga
su contexto, prepara la pieza, la comprueba con el verificador de marca y la
entrega como **borrador**. El cliente la revisa en la plataforma y la acepta o
pide cambios.

Cómo debe trabajar la sesión: [`INSTRUCCIONES.md`](./INSTRUCCIONES.md).

## Cómo entra

Como **un usuario normal de la plataforma**: la cuenta de la agencia, con correo
y contraseña, y la clave **pública** del proyecto. Todo pasa por la RLS y por las
funciones de la base de datos, así que la sesión solo puede hacer lo que haría
esa persona desde la aplicación. La herramienta se niega a arrancar con la clave
de servicio o con un archivo de credenciales dentro del repositorio.

## Instalación

Necesita Node 22.18 o posterior (ejecuta TypeScript sin compilar).

```sh
npm ci              # en la raíz del repositorio: la herramienta reutiliza el
                    # esquema del documento, el catálogo de redes y el verificador
                    # de marca de src/ (y su zod)
cd agency
npm ci              # solo para las pruebas (vitest y typescript)
```

## Credenciales

Archivo JSON **fuera del repositorio**, por defecto
`~/.rrss-agencia/credenciales.json` (en Windows, `%USERPROFILE%\.rrss-agencia\credenciales.json`):

```json
{
  "url": "https://<proyecto>.supabase.co",
  "anonKey": "<clave pública (anon) del proyecto>",
  "email": "<correo de la cuenta de la agencia>",
  "password": "<contraseña de esa cuenta>"
}
```

Protégelo como cualquier contraseña (en Linux y macOS, `chmod 600`).

## Variables

| Variable | Para qué | Por defecto |
|---|---|---|
| `RRSS_AGENCIA_CREDENCIALES` | Ruta del archivo de credenciales | `~/.rrss-agencia/credenciales.json` |
| `RRSS_AGENCIA_TRABAJO` | Carpeta de trabajo: una subcarpeta por encargo con su contexto, la entrega y el cerrojo | `~/.rrss-agencia/trabajo` |
| `RRSS_AGENCIA_CERROJO_MINUTOS` | Cuánto dura el cerrojo al tomar un encargo (5 a 1440) | `240` |

## Órdenes

Desde `agency/`:

```sh
npm run agencia -- pendientes [--json]
npm run agencia -- tomar <id> [--renovar]
npm run agencia -- contexto <id>
npm run agencia -- comprobar <carpeta>/entrega.json [--contexto <carpeta>] [--json]
npm run agencia -- entregar <id> <carpeta>/entrega.json [--aun-con-bloqueos]
npm run agencia -- comprobar-plan <carpeta>/plan.json [--contexto <carpeta>]
npm run agencia -- entregar-plan <id> <carpeta>/plan.json
npm run agencia -- importadas [<marca>] [--descargar] [--limite N]
npm run agencia -- comprobar-plantillas <plantillas.json>
npm run agencia -- entregar-plantillas <marca> <plantillas.json> [--manual]
npm run agencia -- comentar <id> "texto"
npm run agencia -- soltar <id>
```

| Orden | Qué hace |
|---|---|
| `pendientes` | Encargos de las marcas que la cuenta puede **editar**: pedidos, con cambios pedidos, y los que están en curso con el cerrojo caducado o de esta cuenta |
| `tomar` | Toma el encargo con una clave de sesión nueva (cerrojo con caducidad). Si otra sesión lo tiene, la plataforma lo rechaza (`RQ001`). `--renovar` alarga el cerrojo propio |
| `contexto` | Escribe en `<trabajo>/<id>/`: `encargo.json` (encargo y conversación), `perfil.json` (perfil de marca vigente), `red.json` (límites y especificación de la red y formato, proporción del lienzo), `recursos.json` (recursos de referencia y logotipos con URL firmadas que caducan a las 6 h) y `pieza-actual.json` (documento vigente si el encargo es sobre una pieza existente) |
| `comprobar` | Sin red: valida la entrega con el esquema del documento y `PostCopy` de la aplicación y pasa el **verificador de marca sin IA** (`src/features/brandcheck`) a la pieza y a cada variante. Sale con 1 si hay bloqueos |
| `entregar` | Vuelve a leer del servidor el encargo, el perfil y la pieza, valida y comprueba, y llama a `deliver_content_request`: crea la pieza (o una versión nueva de la enlazada) en **borrador** con la nota «Entregado por la agencia» y marca el encargo como entregado. Las variantes se publican como comentario. Con bloqueos no entrega salvo `--aun-con-bloqueos` |
| `comprobar-plan` | Sin red: valida un plan de campaña con el mismo esquema que la aplicación (`src/features/campaigns/plan.ts`) contra la campaña de `campana.json`, y ensaya el motor que lo convertirá en borradores |
| `entregar-plan` | Vuelve a leer la campaña del servidor, valida y llama a `deliver_campaign_plan`: el encargo queda entregado y la campaña, «por revisar». No crea piezas: las crea el motor cuando el cliente acepta el plan en Campañas |
| `importadas` | Sin marca, las marcas con publicaciones importadas de Instagram; con marca, deja en `<trabajo>/plantillas-<marca>/` lo importado, su resumen, el perfil, la biblioteca y, con `--descargar`, las imágenes más recientes, para sacar las plantillas de diseño (docs/importar-publicaciones.md) |
| `comprobar-plantillas` | Sin red: valida el archivo con el esquema del documento v3 y del análisis de la aplicación |
| `entregar-plantillas` | Valida y llama a `deliver_design_templates`: las guarda como plantillas de la marca (la base de datos exige recursos de la marca y ejemplos que sean publicaciones importadas) |
| `comentar` | Comentario en la conversación del encargo |
| `soltar` | Devuelve un encargo tomado a la cola sin entregarlo |

## Archivo de entrega

Ejemplo completo: [`ejemplos/entrega.json`](./ejemplos/entrega.json).

```jsonc
{
  "format": "rrss.agency-delivery",
  "version": 1,
  "title": "Nombre interno de la pieza (opcional)",
  "copy": {                       // texto de la publicación (PostCopy del editor)
    "caption": "Pie de la publicación",
    "hashtags": ["sin", "almohadilla"],
    "mentions": ["sin_arroba"],
    "altText": "Descripción de la imagen",
    "callToAction": { "label": "Reserva", "url": "https://…" }
  },
  "variants": [                   // opcional, hasta 5: otras propuestas de texto
    { "caption": "…", "hashtags": ["…"] }
  ],
  "document": {                   // opcional: documento por páginas y capas del editor (v4)
    "schemaVersion": 4,
    "canvas": { "aspectRatio": "4:5", "width": 1080, "height": 1350, "backgroundColor": "#FFFFFF" },
    "pages": [                    // una en un post; de 2 a 10 en un carrusel, en el orden en que se publican
      { "id": "portada", "name": "Portada", "layers": [ /* image (source.assetId de la biblioteca), text, logo, shape */ ] }
    ]
  }
}
```

- **Carruseles:** una sola pieza con varias páginas en el mismo documento, todas
  con el mismo lienzo y el mismo `copy` (ejemplo:
  [`ejemplos/entrega-carrusel.json`](./ejemplos/entrega-carrusel.json)). Los
  identificadores de capa son únicos en todo el documento. `comprobar` y
  `entregar` bloquean un carrusel con menos de 2 o más de 10 páginas, y un post
  con más de una (comprobación `pages` del verificador).
- Un documento de las versiones 1 a 3 (`layers` en el documento, sin `pages`)
  se sigue aceptando: se convierte en uno de una sola página. El formato de la
  entrega no cambia de versión (`"version": 1`): el documento lleva la suya.

- Sin `document`, si el encargo es sobre una pieza existente se conserva su
  lienzo y sus capas y se cambia el texto; si no, se crea un lienzo vacío con la
  proporción recomendada para la red.
- Las imágenes y logotipos solo pueden ser recursos de la biblioteca de la marca
  (`assetId`), nunca imágenes incrustadas.

## Encargos de tipo «plan» (Campañas)

Con la marca en modo agencia, el cliente pide desde **Campañas** un plan
(«prepara la semana que viene») con redes y fechas. Llega a `pendientes` como un
encargo más, con formato `plan`. Se toma igual (`tomar`); `contexto` escribe
`encargo.json` y `perfil.json` y, en vez de `red.json`, `recursos.json` y
`pieza-actual.json`:

- `campana.json`: instrucción, fechas, redes con sus formatos del catálogo y las reglas del plan;
- `biblioteca.json`: fotos y vídeos de la marca (id, nombre, etiquetas, carpeta) para sugerir por su id;
- `plan-plantilla.json`: el archivo de entrega con la forma exacta.

Ejemplo completo: [`ejemplos/plan.json`](./ejemplos/plan.json).

```jsonc
{
  "format": "rrss.agency-plan",
  "version": 1,
  "note": "Nota para la conversación (opcional)",
  "plan": {
    "objective": "…",
    "summary": "…",
    "reasoning": { "observed": [], "dataBacked": [], "hypotheses": [], "dataNote": "…" },
    "pieces": [
      { "network": "instagram", "format": "post", "date": "2026-11-23", "idea": "…", "caption": "…",
        "hashtags": ["sin_almohadilla"], "assetIds": [], "why": "…" }
    ]
  }
}
```

La forma es **cerrada**: cualquier campo de más invalida el plan entero (también
en la base de datos). El cliente puede pedir cambios (el encargo vuelve a la
cola) o aceptarlo en Campañas; al aceptarlo, la plataforma crea las piezas como
**borradores**. Ni la agencia ni el plan aprueban, programan o publican nada.

## Cuenta de la agencia en staging

1. Crear (registrarse) la cuenta de la agencia en la aplicación de staging con
   su correo; confirmar el correo.
2. Desde la organización del cliente, un administrador invita ese correo como
   **Miembro** con rol **Editor** en cada marca que gestionará la agencia
   (Ajustes → Equipo, o Equipo de la marca). La cuenta de la agencia acepta la
   invitación.
3. El gestor de la marca elige, en **Marca → Datos de la marca → Redacción con
   IA**, «La agencia, por encargo». Con eso aparece la sección Encargos en el
   menú de la marca y «Pedir a la agencia» en el editor (en lugar de «Redactar
   con IA»).
4. En la máquina de la agencia, el archivo de credenciales con la URL y la clave
   pública de staging y el correo y la contraseña de esa cuenta.

La cuenta de la agencia no necesita ningún otro rol: no es administradora de la
organización del cliente y no puede aprobar.

## Pruebas

```sh
cd agency
npm test          # contra un Supabase simulado (servidor HTTP local); no conecta con nada
npm run typecheck
```

Las funciones de la base de datos se prueban contra las migraciones reales en
`tests/db/encargos.test.ts` (desde la raíz, `npm run test:db`).
