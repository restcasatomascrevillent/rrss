# Biblioteca con fotos de Google Drive

Una organización conecta su Google Drive y sus marcas usan en la biblioteca las fotos
que ya tiene allí, **sin copiarlas a Supabase**: el recurso guarda solo el id del
archivo de Drive y sus metadatos, y la imagen se pide a Drive cada vez que se ve o se
usa. Pensado para planes con poco almacenamiento (staging es el plan gratuito, 1 GB).

Estado a 19/11/2026:

| Qué | Estado |
|---|---|
| Base de datos: conexiones, token cifrado, recursos de Drive (migración `20261122010000`, con vuelta atrás) | Implementado y probado (PGlite, migraciones reales; casos en `tests/db/aislamiento.test.ts` y `tests/db/biblioteca-drive.test.ts`) |
| Edge Function `drive-media` (conectar, navegar, añadir, firmar, servir) | Probada contra **Drive simulado** |
| Adaptador real de Google (`_shared/drive/google-drive.ts`) | Escrito contra la documentación, **sin probar contra Google**: falta el cliente OAuth |
| Interfaz: «Configuración → Google Drive» y «Biblioteca → Desde Google Drive» | Implementada; solo sale con Drive configurado en Plataforma → Integraciones; la recorre la prueba e2e |
| Editor, exportación y trabajador de medios leyendo de Drive | Editor y exportación por `useSignedUrls`; trabajador por `drive-media/sign` (probado con servidor simulado) |
| Prueba e2e `tests/e2e/20-biblioteca-drive.spec.ts` | Pasa en local (19/11/2026, rama `f4/integracion`) |
| Fotos HEIC del iPhone | **No se pueden usar**: el navegador no las pinta y Drive no les hace miniatura. Hay que convertirlas a JPEG antes |
| Desplegado en staging | **No** (ni migración ni función) |

## 1. Cómo funciona

1. **Conectar** (Configuración → Google Drive, solo quien administra la organización).
   `drive-media/start` pide a la base de datos el estado anti-CSRF
   (`drive_oauth_begin`, con la sesión de la persona) y manda a Google con el permiso
   `drive.readonly` (más `openid email` para saber qué cuenta es). Google vuelve a
   `drive-media/callback`: se gasta el estado (10 min, un uso), se cambia el código por
   tokens, se cifra el **token de refresco** con AES-256-GCM (las mismas claves
   `SOCIAL_TOKEN_KEYS` que los tokens de Meta, con la organización y la cuenta como dato
   asociado) y se guarda en `private.drive_connection_secrets`. El navegador nunca ve
   un token. Se pueden conectar varias cuentas de Google por organización.
2. **Elegir fotos** (Biblioteca → Desde Google Drive; quien edita la marca, solo si la
   organización tiene una conexión activa). `drive-media/browse` comprueba con la
   sesión (`drive_connection_for_brand`) que la persona edita la marca y que la conexión
   es de su organización, y lista carpetas e imágenes de Drive con miniaturas firmadas.
3. **Añadir**: `drive-media/import` vuelve a leer cada archivo **en Google** (lo que
   diga el navegador no cuenta), rechaza lo que no sea JPEG, PNG, WebP o GIF, y da de
   alta los recursos con `drive_assets_import` (solo la clave de servicio; comprueba
   otra vez la capacidad de la persona y la organización de la conexión). El mismo
   archivo no se duplica en una marca.
4. **Ver y usar**: el recurso tiene una ruta virtual `<org>/<marca>/drive/<id de Drive>`.
   `useSignedUrls` la reconoce y pide a `drive-media/sign` la dirección: la función
   lee los recursos **con la sesión de la persona** (RLS de `media_assets`: solo los de
   marcas que ve) y firma direcciones `…/drive-media/file/<firma>` que valen 1–2 h
   (HMAC con una clave derivada de `SOCIAL_TOKEN_KEYS`). Esas direcciones se pueden
   poner en un `<img>` o en Konva sin cabeceras, responden con CORS abierto (el lienzo
   no queda «manchado» y la exportación funciona) y `cache-control: private`.
   La biblioteca usa la miniatura de Google en la rejilla y el archivo entero en la
   ficha y el editor.
5. **Trabajador de medios**: si la ruta de un trabajo es de Drive, el trabajador pide la
   firma a `drive-media/sign` con la clave de servicio y baja el archivo por la
   dirección firmada (`worker/src/supabase.ts`).

Lo que **no** hace: no escribe, mueve ni borra nada en Drive; borrar un recurso de la
biblioteca solo borra la referencia. Desconectar borra el token: los recursos se
quedan sin imagen hasta que se vuelve a conectar **la misma cuenta**, que los recupera.
Si Google revoca el acceso (`invalid_grant`), la conexión pasa a «hay que volver a
conectarla».

## 2. Garantías (las impone la base de datos)

- `drive_connections`: RLS; la leen los miembros de la organización; nadie la escribe
  desde el cliente (todo por RPC). Tokens y estados en `private` (sin acceso del cliente).
- Un recurso de Drive solo lo crea el servidor: las columnas `source`,
  `drive_connection_id` y `drive_file_id` no tienen privilegio de escritura para
  `authenticated`, y además un disparador (`media_assets_drive_guard`) impide crear uno
  o cambiar a qué archivo apunta, y reserva las rutas `…/drive/…`.
- Forma comprobada: un recurso de Drive tiene archivo y ruta `<org>/<marca>/drive/<id>`;
  uno de Storage no tiene nada de Drive.
- No ocupa plan: `private.org_storage_bytes` cuenta solo `source = 'storage'`, y borrar
  un recurso de Drive no anota nada en la cola de limpieza de Storage.

## 3. Variables y secretos

Funciones (`drive-media`); ninguna llega al navegador. El cliente de Google y la
dirección de la aplicación se meten en **Plataforma → Integraciones → Google Drive**
(migración `20261123010000`; el secreto, cifrado en Vault) y mandan sobre las
variables; el resto, como variables de la función:

| Variable | Qué es |
|---|---|
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET` | Cliente OAuth de Google del producto (tipo «Aplicación web») |
| `DRIVE_CALLBACK_URL` | `https://<proyecto>.supabase.co/functions/v1/drive-media/callback`; si falta y `SUPABASE_URL` es https, se deduce |
| `DRIVE_APP_URL` | Dirección de la aplicación para volver tras conectar (si falta, `SOCIAL_APP_URL`) |
| `DRIVE_ALLOWED_ORIGIN` | CORS de las rutas con sesión (por defecto `*`; la sesión va en cabecera). Las imágenes siempre `*` |
| `SOCIAL_TOKEN_KEYS`, `SOCIAL_TOKEN_KEY_ID` | Las mismas de Meta (docs/publicacion.md): cifran el token y firman las direcciones |
| `DRIVE_E2E_SIMULATED=true` | Solo pruebas locales: Drive simulado; la función no arranca si `SUPABASE_URL` no es local |

Aplicación: `VITE_DRIVE_LIBRARY_ENABLED=true` permite Drive en ese despliegue, pero
«Configuración → Google Drive» y «Conectar Google Drive» solo salen si además el
servidor dice que Drive está configurado (`platform-integrations`, acción
`availability`: cliente OAuth, direcciones y claves de cifrado), y «Desde Google
Drive» en la biblioteca, si además hay una conexión activa. (Pendiente de llevar a
`.env.example`, como el resto de variables nuevas.)

«Probar conexión» de Google Drive comprueba que la configuración está completa sin
llamar a Google: no hay una llamada gratuita que valide un cliente OAuth sin una
persona que lo autorice, así que el cliente **se comprueba al conectar** (como
Ideogram).

## 4. Lo que hace falta de Google (lo crea el dueño)

1. Proyecto de Google Cloud (puede ser el mismo que el de Vertex) con la **Google Drive
   API** activada.
2. **Pantalla de consentimiento OAuth** de tipo «Externo», con el nombre del producto,
   el dominio y la política de privacidad, y los permisos `drive.readonly`, `openid` y
   `email`.
3. **Cliente OAuth «Aplicación web»** con el URI de redirección
   `https://zzkdrfhqmjfvrdsoguio.supabase.co/functions/v1/drive-media/callback`
   (staging). Su id y su secreto van a las variables de arriba.
4. `drive.readonly` es un permiso **restringido** para Google:
   - En modo **«Testing»** funciona con hasta 100 usuarios de prueba añadidos a mano,
     pero **el token de refresco caduca a los 7 días** (habría que reconectar cada semana).
   - En **«In production» sin verificar** funciona (con un aviso de «aplicación no
     verificada» al conectar) hasta 100 usuarios y el token no caduca. Es lo razonable
     para la agencia y sus primeros clientes.
   - Para abrirlo a cualquiera, Google exige la verificación de permisos restringidos
     (evaluación de seguridad anual). Alternativa futura sin verificación pesada:
     `drive.file` + Google Picker (cada persona elige los archivos y la aplicación solo
     ve esos).

## 5. Pendiente

- **HEIC**: convertir en el trabajador (FFmpeg ≥ 7.1 lee HEIF) y guardar el JPEG en
  una carpeta de la aplicación en Drive necesitaría permiso de escritura (`drive.file`).
  Mientras tanto, el diálogo enseña las HEIC deshabilitadas con el aviso de exportarlas
  a JPEG.
- Vídeos de Drive en la biblioteca (hoy solo imágenes).
- Una marca no puede limitarse a una conexión o carpeta concreta: cualquier editor de
  una marca de la organización navega todas las conexiones de la organización. Para una
  agencia con varios clientes conviene asignar conexión (y carpeta raíz) por marca.
- Si un archivo se borra en Drive, la biblioteca sigue enseñando el recurso (sin imagen).
- La exportación de datos de la organización (RGPD) lista los recursos de Drive pero no
  incluye sus archivos.
