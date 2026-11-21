# Puesta en marcha

## En local

```bash
npm install
```

```bash
cp .env.example .env.local
```

Rellena `.env.local` con la URL y la clave pública (`anon`) del proyecto de
Supabase de desarrollo y arranca:

```bash
npm run dev
```

Las pruebas no necesitan Supabase:

```bash
npm test
```

```bash
npm run test:db
```

`test:db` aplica las migraciones reales a un Postgres en memoria. Para usar un
Postgres local, define `DATABASE_URL` con un superusuario; crea y borra una base
de datos temporal.

### Supabase local y prueba de extremo a extremo

Hace falta Docker en marcha y la CLI de Supabase. El stack local se llama
`rrss-local` y usa puertos propios (`supabase/config.toml`): API en el 55321,
Postgres en el 55322 y buzón de correo (Mailpit) en el 55324. No se enlaza con
ningún proyecto remoto.

```bash
supabase start
```

Aplica las migraciones de `supabase/migrations/` en una base nueva. Si el
volumen de Docker ya existía (el stack se llama igual en todas las copias del
repositorio), aplica las que falten con `supabase migration up --local`.

```bash
npm run test:e2e
```

No hace falta `.env.local` para la prueba: `playwright.config.ts` lee la URL y
la clave `anon` del stack local con `supabase status -o env` (la clave anónima
local es pública y la misma en todas las máquinas) y se las pasa a Vite por
entorno, junto con `VITE_AI_TEXT_ENABLED=true`, `VITE_AI_IMAGE_ENABLED=true` y
`VITE_MEDIA_WORKER_ENABLED=true`. Para `npm run dev` contra el stack local sí
hace falta `.env.local` con la URL y la clave (y los interruptores que se
quieran ver).

`11-reels.spec.ts` arranca además el **trabajador de medios** de verdad contra
el stack local (`node worker/scripts/run-supabase.ts local`, que lee la URL y la
clave de servicio de `supabase status` en el momento). Necesita Node ≥ 22.18,
`npm ci` en `worker/` y `ffmpeg`/`ffprobe` en el PATH (ver `worker/README.md`).
Para ejecutar solo ese archivo tras una tanda completa:
`E2E_CONTINUAR=1 npx playwright test tests/e2e/11-reels.spec.ts`.

Playwright (Chromium; la primera vez, `npx playwright install chromium`) arranca
dos procesos: `supabase functions serve --env-file supabase/functions/e2e.env`
(las funciones `ai-generate`, `ai-media` y `ai-media-poll` con los simulados
de pruebas locales) y la aplicación en el puerto 5273. Recorre en un navegador de verdad la Fase 1
(registro con confirmación de correo, dos organizaciones, alta de marcas, perfil
con versiones, biblioteca, invitaciones y roles, aislamiento, recuperación de
contraseña, ajustes, actividad y panel de plataforma) y la aceptación de la
Fase 2 (`09-fase2-ia-editor-y-cupo.spec.ts`): texto generado con IA para dos
marcas, cada uno conforme a su perfil; edición de texto y capa con versiones e
historial; comprobación de marca sin IA y con IA; coste por organización en
«Consumo de IA», y cupo agotado que detiene la generación sin llamar al
proveedor. Después, `10-fase2-imagen-con-ia.spec.ts` (imagen con IA síncrona y
asíncrona desde el editor; la asíncrona la cierra `ai-media-poll`, que la
prueba llama con la clave de servicio local porque en local no hay secretos de
Vault), `11-reels.spec.ts` (encargar un reel, montarlo con el trabajador y
verlo en la biblioteca) y `12-modo-agencia-encargos.spec.ts` (una clienta pide
un encargo, la herramienta `agency/` lo toma y entrega, la clienta pide un
cambio y acepta; necesita `npm ci` en `agency/`). Siguen, sin ejecutar todavía en local, los de las Fases 3 a 6, en el orden de
las fases: `13-publicacion-calendario.spec.ts` (conectar Instagram con la Graph
API simulada, programar y publicar), `14-campanas-plan-por-instruccion.spec.ts`
(plan de campaña y borradores), `15-analitica.spec.ts` (capturar las métricas
de la cuenta conectada en el 13, panel e informe mensual en PDF con el
trabajador; necesita `npm ci` en `worker/`), `16-planes.spec.ts` (margen y
asignación de planes; deja la organización B en «Heredado») y `17-rgpd.spec.ts` (registro con
consentimiento, descargar mis datos y borrar una cuenta de usar y tirar).

El proveedor simulado solo se activa con `AI_E2E_SIMULATED_PROVIDER=true` **y**
un Supabase local (dentro de Docker la función ve `SUPABASE_URL=http://kong:8000`,
que también cuenta como local); en cualquier otro entorno, si la variable está,
la función no arranca. Sus respuestas se construyen a partir del perfil y del
encargo de forma determinista. `supabase/functions/e2e.env` no lleva secretos:
las claves del stack local las pone la CLI. Los archivos de
`tests/e2e/` van en orden y cada tanda usa correos con un sufijo nuevo, así que
no hace falta vaciar la base entre ejecuciones. Para empezar de cero:

```bash
supabase db reset
```

Al terminar, `supabase stop` libera los contenedores (los datos quedan en un
volumen de Docker; `supabase stop --no-backup` los borra).

### La prueba de extremo a extremo en CI

El trabajo `e2e` de `.github/workflows/ci.yml` repite en GitHub Actions lo que
se hace en local: instala la CLI de Supabase (`supabase/setup-cli`, versión
fijada a la usada en local), levanta el stack desde `supabase/config.toml`
(`supabase start -x studio,vector,imgproxy,analytics`), hace `npm ci` en la
raíz, `worker/` y `agency/`, instala FFmpeg y Chromium y ejecuta
`npm run test:e2e`. No usa secretos: la clave anónima del stack local es pública.

- **No bloquea el PR todavía** (`continue-on-error: true`): hasta que se vea
  estable en GitHub, un fallo deja el trabajo en rojo pero no rompe la
  comprobación global. Cuando haya varias ejecuciones seguidas en verde, quitar
  esa línea y marcarlo como obligatorio.
- **Tiempo:** tope de 45 minutos; se estiman 20-30 (arranque del stack y de
  Chromium unos 3-5 min la primera vez, y la tanda local de 57 escenarios).
- **Cachés:** npm (tres `package-lock.json`) y el navegador de Playwright por
  versión. Las imágenes de Docker de Supabase no se cachean: se bajan en cada
  ejecución (guardarlas cuesta lo mismo y gasta el límite de caché).
- **Si falla** se sube el artefacto `e2e-informe` (14 días): `playwright-report/`,
  `test-results/` (capturas y trazas, con `E2E_TRAZA=1`) y `diagnostico/` (registros
  de los contenedores). Una traza se abre con `npx playwright show-trace <zip>`.
- En CI (`CI=true`) `global-setup.ts` espera hasta 60 s a que respondan la API y
  el buzón, y el informe añade las anotaciones de GitHub.

## Entornos remotos

El producto usa **cuentas nuevas**, sin relación con las de Casa Tomás.

### 1. Supabase

#### Lo que hay (18/11/2026)

| Qué                 | Valor                                                                                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proyecto de staging | `zzkdrfhqmjfvrdsoguio` (`https://zzkdrfhqmjfvrdsoguio.supabase.co`), en la cuenta de Supabase de Oficiosos                                                              |
| Región              | West EU (Irlanda)                                                                                                                                                       |
| Plan                | **Gratuito**, por decisión del dueño. Se trabaja dentro de sus límites y se avisa antes de cualquier cosa que obligue a pasar a Pro                                     |
| Base de datos       | Postgres 17. Las 8 migraciones de `supabase/migrations/` aplicadas y registradas; 19 tablas en `public`, todas con RLS; cubo `brand-media` (privado, 50 MB por archivo) |
| Funciones           | `ai-generate` desplegada **sin proveedor de IA ni secretos**: responde que la IA no está disponible. `VITE_AI_TEXT_ENABLED` no debe activarse contra este proyecto      |
| Producción          | No existe todavía                                                                                                                                                       |

#### El envoltorio `scripts/supabase-rrss.sh`

En esta máquina la CLI global de Supabase tiene abierta la sesión de **otra
cuenta** (la de Casa Tomás). Para no mezclar cuentas, todo lo de rrss se hace
con el envoltorio, desde la carpeta del repositorio:

```bash
bash scripts/supabase-rrss.sh <orden de supabase> [argumentos]
```

```bash
bash scripts/supabase-rrss.sh migration list
```

- Lee un token de acceso personal de la cuenta de Oficiosos de
  `~/.supabase-rrss/token` (o de la ruta de `RRSS_SUPABASE_TOKEN_FILE`) y lo
  pasa a la CLI solo en el entorno de ese proceso: no se imprime ni toca la
  sesión global. El token **nunca** va al repositorio ni a ningún documento.
- Deja el proyecto fijado: si la carpeta está enlazada a otro proyecto o se pide
  otro con `--project-ref`, no ejecuta nada.

Para la API de gestión de Supabase con `curl`, el token se carga en una variable
dentro del mismo comando y se usa en la cabecera `Authorization: Bearer`.

#### Cómo se aplicaron las migraciones

No se usa `supabase db push` (ni `db reset` ni `migration repair`) contra el
proyecto remoto. Cada migración se aplicó con un archivo temporal, fuera del
repositorio, que la envuelve en una transacción y registra su fila en el
historial de la CLI:

```sql
begin;
-- contenido de supabase/migrations/<marca>_<nombre>.sql
insert into supabase_migrations.schema_migrations (version, name)
values ('<marca>', '<nombre>');
commit;
```

```bash
bash scripts/supabase-rrss.sh db query --linked -f <archivo temporal> --output-format json
```

Así, si algo falla, no queda nada a medias, y `migration list` muestra lo
aplicado. Las migraciones nuevas siguen el mismo camino: primero `npm run test:db`,
después staging.

#### Inicio de sesión (Authentication)

Configurado por la API de gestión (`PATCH /v1/projects/{ref}/config/auth`):

| Ajuste                                  | Valor                                                                                                                                     | Campo de la API              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Confirmar correo                        | **Activado** (requisito de seguridad: las invitaciones se aceptan por coincidencia de correo)                                             | `mailer_autoconfirm = false` |
| Longitud mínima de contraseña           | 8                                                                                                                                         | `password_min_length`        |
| Protección contra contraseñas filtradas | **No disponible en el plan gratuito** (la API responde 402, `entitlement_required`): es de Pro en adelante                                | `password_hibp_enabled`      |
| URL del sitio                           | `https://rrss-omega.vercel.app` (desde el 18/11/2026; antes `http://localhost:5173`)                                                                                              | `site_url`                   |
| Direcciones de retorno                  | `https://rrss-omega.vercel.app/**`, `http://localhost:5173/**` y `http://127.0.0.1:5173/**` (cubren `/` tras confirmar el correo y `/restablecer` al recuperar la contraseña) | `uri_allow_list`             |
| Registro abierto                        | Sí                                                                                                                                        | `disable_signup = false`     |

Cuando haya dominio o vistas previas de Vercel hay que cambiar la URL del sitio
y añadir sus direcciones de retorno.

#### Limitaciones del correo integrado (plan gratuito, sin SMTP propio)

Según la documentación de Supabase (_Auth → Send emails with custom SMTP_,
consultada el 18/11/2026):

- **Solo envía a direcciones del equipo** de la organización de Supabase
  (pestaña _Team_). A cualquier otra dirección responde
  «Email address not authorized».
- **2 correos por hora** en todo el proyecto (valor que Supabase puede cambiar
  sin aviso; la API lo muestra en `rate_limit_email_sent`).
- Sin garantía de entrega: es solo para pruebas.

Consecuencias: el registro, la confirmación y la recuperación de contraseña
solo se pueden probar en staging con correos de miembros del equipo de
Supabase, y a ritmo de dos correos por hora. La prueba de extremo a extremo
(`npm run test:e2e`), que registra muchas cuentas con correos inventados, **no
se puede repetir en staging** sin un SMTP propio (se configura en
_Authentication → SMTP_ o con los campos `smtp_*` de la misma API; el plan
gratuito lo admite).

#### Alertas de Supabase (advisors, 18/11/2026)

- **Seguridad (15 avisos).** Todos son «función `SECURITY DEFINER` ejecutable
  por `authenticated`»: son las funciones RPC de la aplicación (crear
  organización, invitaciones, versiones de contenido, administración…). Es
  intencionado: cada una comprueba dentro la sesión y los permisos
  (`private.is_platform_admin()`, pertenencia a la organización, coincidencia de
  correo) y tiene `search_path = ''`; `anon` no puede ejecutarlas. Sin tablas
  sin RLS ni vistas expuestas.
- **Rendimiento (47 avisos informativos).** 25 índices «sin usar»: falsa
  alarma, la base aún no tiene tráfico. 22 claves foráneas sin índice que las
  cubra por completo (columnas `created_by`, `updated_by`, `accepted_by` y las
  compuestas marca + organización): solo afectan al borrar una cuenta o una
  marca y con estos volúmenes no importa. Se revisarán con datos reales.

#### Lo que queda por hacer

1. Dar de alta al primer superadministrador, una vez registrado en la
   aplicación (lo hace el dueño):

   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'TU_CORREO';
   ```

2. Con el superadministrador dado de alta, las claves de los servicios (Meta,
   ComfyUI, IA de texto e imagen, Stripe) se meten en **Plataforma →
   Integraciones** en vez de con `supabase secrets set`: se guardan cifradas en
   Supabase Vault (migración `20261120010000`, función `platform-integrations`),
   no se vuelven a ver (la pantalla enseña «configurado · pista · fecha ·
   quién»), mandan sobre las variables de entorno y cada una tiene «Probar
   conexión». Lo que sigue siendo variable: la clave de servicio y la URL de
   Supabase (las pone Supabase), los orígenes CORS, los interruptores de las
   pruebas locales y el vídeo con IA.
3. SMTP propio si se quiere probar con más cuentas o a más ritmo.
4. Proyecto de producción (y decidir si sigue en el plan gratuito).

### 2. Vercel

Hecho el 18/11/2026: proyecto `rrss` en el equipo `casa-tomas` (plan Pro), conectado a
este repositorio, con `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` de **staging** en
_Production_ y _Preview_, desplegado desde la CLI: https://rrss-omega.vercel.app (las
vistas previas piden iniciar sesión en Vercel; la dirección de producción es pública).
No hay ninguna `VITE_AI_*` ni `VITE_MEDIA_WORKER_ENABLED`.

1. Proyecto nuevo importando este repositorio (framework: Vite).
2. Variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`: las de producción
   en _Production_, las de staging en _Preview_.
   `VITE_AI_TEXT_ENABLED=true` solo en el entorno cuya función `ai-generate`
   tenga un proveedor de IA de texto configurado: sin ella no se enseñan
   «Redactar con IA», la comprobación de tono ni la propuesta de perfil (lo que
   no funciona no sale en la interfaz). `VITE_AI_ACCOUNT_CURRENCY` (opcional)
   fija la moneda de los importes de IA. `VITE_MEDIA_WORKER_ENABLED=true` solo
   en el entorno que tenga desplegado el trabajador de medios (`worker/`) contra
   su Supabase: sin ella no aparece «Montar un reel» en la biblioteca (un reel
   encargado sin trabajador se quedaría en cola para siempre).
   Desde la migración `20261120010000`, `VITE_AI_TEXT_ENABLED`,
   `VITE_AI_IMAGE_ENABLED`, `VITE_SOCIAL_PUBLISHING_ENABLED` y
   `VITE_BILLING_ENABLED` dicen qué módulos **permite** ese despliegue; la
   interfaz los enseña solo si además el servidor dice que su integración está
   configurada (`platform-integrations`, solo booleanos). Se pueden poner a
   `true` una vez por despliegue y configurar después cada servicio desde
   Plataforma → Integraciones; lo que no esté configurado sigue sin salir.
   Igual, desde `20261123010000`: `VITE_AI_VOICE_COPILOT_ENABLED` (copiloto por
   voz; necesita además la IA de texto) y `VITE_DRIVE_LIBRARY_ENABLED` (fotos de
   Google Drive en la biblioteca; necesita la integración Google Drive).
3. Rama de producción `main`; `staging` como entorno de validación.
4. Dominio propio.

Nunca se pone la clave de servicio de Supabase en variables `VITE_`.

### 3. Comprobación tras desplegar

1. Registrar dos cuentas, crear una organización con cada una y una marca en
   cada organización.
2. Comprobar que ninguna ve la organización, las marcas ni los archivos de la otra.
3. Invitar a una tercera cuenta como cliente de una marca y comprobar que solo
   ve esa marca y no puede editar.

## Circuito de cambios

`feature/*` o `fix/*` → PR a `staging` → validar en staging → PR de versión a
`main`. Las migraciones se aplican en staging antes que en producción. Antes de
cada PR: `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:db`,
`npm run build`.
