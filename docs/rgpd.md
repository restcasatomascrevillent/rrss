# RGPD: registro de actividades de tratamiento y derechos

> **BORRADOR PARA REVISAR.** Esto no es asesoría legal. Las bases legales y los
> plazos son **propuestas** para preparar la consulta con un abogado; lo que
> está entre corchetes son datos o decisiones que faltan. Lo que se describe del
> producto (qué datos trata, dónde y cómo se exportan o se borran) es lo que hace
> el código a 19/11/2026.

Responsable: [RAZÓN SOCIAL], CIF [CIF], [DIRECCIÓN]. Contacto de privacidad:
[CORREO DE PRIVACIDAD]. Delegado de protección de datos: [SI SE NOMBRA].

## 1. Dos papeles

| Papel | Sobre qué datos | Qué hace falta |
|---|---|---|
| **Responsable** | Cuentas de usuario, aceptaciones, seguridad, registro técnico y, cuando exista, facturación | Este registro (art. 30.1) y la política de privacidad |
| **Encargado** de cada organización cliente | Lo que la organización sube o crea: marcas, perfiles de marca, contenidos y versiones, encargos y comentarios, biblioteca, uso de la IA, miembros de su equipo | Contrato de encargo del tratamiento con cada cliente (art. 28) [PENDIENTE] y registro como encargado (art. 30.2) |

## 2. Actividades de tratamiento (como responsable)

| Actividad | Datos | Personas | Finalidad | Base legal propuesta | Conservación propuesta |
|---|---|---|---|---|---|
| Cuentas y acceso | Nombre, correo, contraseña cifrada (la guarda Supabase Auth), idioma, fechas de alta y acceso, metadatos del alta | Usuarios | Identificar y dar acceso | Contrato (6.1.b) | Mientras exista la cuenta; se borra al borrarla |
| Aceptación de documentos legales (`legal_acceptances`) | Documento, versión, fecha, origen (registro o cuenta) | Usuarios | Demostrar que se aceptaron las condiciones y se informó de la privacidad | Obligación de demostrarlo e interés legítimo (6.1.c y 6.1.f) | Mientras exista la cuenta. **A decidir:** conservar una prueba anonimizada tras el borrado |
| Pertenencia y roles | Organización, marca, rol, fechas | Usuarios | Permisos y aislamiento | Contrato (6.1.b) | Mientras sea miembro |
| Registro de actividad (`audit_logs`) | Quién, qué acción, sobre qué, cuándo, la fila afectada sin contenidos | Usuarios | Seguridad y trazabilidad del trabajo en equipo | Interés legítimo (6.1.f) | **A decidir** ([PLAZO]); al borrar una cuenta se anonimiza su autoría; al borrar una organización queda solo la constancia del borrado |
| Uso y coste de la IA (`ai_generations`, `ai_usage`) | Quién pidió, tarea, proveedor, modelo, coste | Usuarios | Cupos, coste y facturación | Contrato e interés legítimo | `ai_generations`, mientras exista la marca; `ai_usage` no tiene datos personales y se conserva para facturación ([PLAZO LEGAL, a confirmar]) |
| Correos de la plataforma | Correo, enlace de confirmación o recuperación | Usuarios e invitados | Confirmar cuentas, recuperar contraseñas | Contrato (6.1.b) | Lo que guarde el proveedor de correo [PENDIENTE] |
| Invitaciones | Correo del invitado, rol, quién invita | Invitados | Dar de alta en una organización | Interés legítimo de la organización (6.1.f) | 14 días de validez; después, mientras exista la organización. **A decidir:** purgar las caducadas |
| Registros técnicos de infraestructura | IP, navegador, peticiones | Visitantes y usuarios | Servir la aplicación y protegerla | Interés legítimo (6.1.f) | Lo que fijen Supabase y Vercel [CONFIRMAR] |
| Facturación | [PENDIENTE: planes y pagos, Fase 6] | Clientes | Cobrar | Obligación legal (6.1.c) | [PLAZO LEGAL] |

Datos de categorías especiales: el producto no los pide. Pueden aparecer en lo
que suben las organizaciones (fotos de personas): es responsabilidad de la
organización tener base legal; el contrato de encargo debe decirlo.

## 3. Encargados del tratamiento y transferencias

La lista que ve el usuario está en `src/features/legal/legal.ts` (política de
privacidad). Resumen:

| Proveedor | Para qué | Región | Transferencia | Estado |
|---|---|---|---|---|
| Supabase | Base de datos, Auth, Storage, funciones | UE (proyecto de staging en UE) | Empresa de EE. UU.: [CONFIRMAR DPA y cláusulas tipo] | En uso |
| Vercel | Aplicación web y registros técnicos | Red global | Empresa de EE. UU.: [CONFIRMAR DPA] | En uso |
| Proveedor de correo | Correos de la plataforma | [PENDIENTE] | [PENDIENTE] | Sin elegir (hoy, el correo integrado de Supabase) |
| Google Cloud · Vertex AI | IA de texto e imagen | Multirregión UE | No | Opcional, recomendado |
| AWS Bedrock | IA de texto | `eu-…` | No | Opcional |
| Mistral | IA de texto | Empresa europea; región de proceso sin confirmar | [CONFIRMAR] | Opcional |
| OpenAI | IA de texto (también el copiloto por voz) | UE solo con un proyecto de región Europa y el endpoint `eu.api.openai.com`; el esquema de salida estructurada queda fuera de la residencia | Ninguna prevista con el endpoint de la UE; con `api.openai.com`, sí (EE. UU.). [CONFIRMAR DPA, elegibilidad y modelos con residencia UE] | Opcional; sin el endpoint de la UE, apagado salvo permiso expreso |
| Black Forest Labs | IA de imagen | `api.eu.bfl.ai` | Puede entrenar salvo contrato enterprise | Opcional |
| ComfyUI propio | IA de imagen (modelos abiertos) | La del servidor | Depende del alojamiento | Opcional |
| Anthropic API directa, Ideogram | IA | EE. UU. / sin documentar | Sí | Apagados: solo con permiso expreso de la organización |
| Higgsfield, fal.ai | Vídeo con IA | Sin región UE | Sí | Apagados |
| Alojamiento del trabajador de medios | Reels y recortes | [PENDIENTE] | [PENDIENTE] | Sin decidir |
| Google · reconocimiento de voz del navegador (Web Speech API de Chrome) | Copiloto por voz del editor: **el dictado de Chrome envía el audio a los servidores de Google** para pasarlo a texto; el producto solo recibe el texto. Lo contrata el navegador de la persona, no el producto, y no se puede pedir región UE | Sin documentar | Sí (Google, EE. UU.) [CONFIRMAR CON EL ABOGADO cómo informarlo] | Apagado salvo `VITE_AI_VOICE_COPILOT_ENABLED`; la persona lo enciende al pulsar «Dictar» |
| Cloudflare R2 | Almacenamiento privado de la biblioteca (opcional frente a Supabase Storage) | Jurisdicción UE del cubo | Cloudflare, Inc. (EE. UU.): encargado; [CONFIRMAR DPA y DPF] | Opcional |
| Google Drive (API) | Biblioteca con fotos de Drive: la organización conecta su cuenta (solo lectura) y las imágenes se piden a Drive cada vez que se ven; el token de refresco se guarda cifrado | La de la cuenta de Google de la organización | Sí (Google, EE. UU.) [CONFIRMAR DPA] | Opcional, sin cliente OAuth todavía |

Al activar un proveedor nuevo hay que añadirlo aquí, en `legal.ts` y avisar a
los clientes según el contrato de encargo.

## 4. Derechos: qué hace la aplicación

| Derecho | Dónde | Cómo se garantiza que solo afecta a la propia persona u organización |
|---|---|---|
| Acceso y portabilidad (persona) | Mi cuenta → **Descargar mis datos** (JSON `rrss.personal-data`) | `export_my_data()` no tiene parámetros: todo se filtra por `auth.uid()` de la sesión. Incluye cuenta (sin contraseña ni tokens), perfil, aceptaciones, organizaciones y roles, invitaciones enviadas y recibidas, actividad hecha por ella, encargos, comentarios, piezas y versiones que creó (sin el documento), recursos que subió, generaciones y trabajos que pidió |
| Portabilidad (organización) | Configuración → Datos → **Exportar los datos** (solo propietarios; JSON `rrss.organization-export`) | `export_organization_data(org)` exige ser propietario y es `SECURITY INVOKER`: además, la RLS de quien llama filtra cada lectura. Incluye configuración, miembros, invitaciones pendientes (sin huella), marcas con perfiles (todas las versiones), fuentes, contenidos con todas sus versiones, encargos con su conversación y la lista de archivos; la aplicación añade un enlace firmado de **1 hora** por archivo, firmado con la sesión del propietario |
| Supresión (persona) | Mi cuenta → **Borrar mi cuenta** (escribir el correo y la contraseña) | Edge Function `delete-account`: el usuario sale del token de sesión, nunca del cuerpo. `gdpr_delete_account_data` (solo clave de servicio) se niega (RG001) si deja una organización con miembros sin propietario; borra las organizaciones donde es el único miembro; después se borra la cuenta de Auth con la API de administración. Los disparadores de `auth.users` la sacan de sus organizaciones, anonimizan las invitaciones que aceptó, dejan sin dueño sus archivos en Storage y quitan su id y su correo del registro de auditoría. Las autorías (`created_by`, `requested_by`, `author_id`…) pasan a null por sus claves foráneas. El trabajo de los demás no se toca |
| Supresión (organización) | Configuración → Datos → **Borrar la organización** (escribir su nombre exacto) | Edge Function `delete-organization`: `gdpr_delete_organization` (solo clave de servicio) comprueba que el usuario del token es propietario (42501) y el nombre (RG002); borra en cascada marcas, perfiles, contenidos, encargos, biblioteca, cupos, trabajos e invitaciones; del registro de auditoría deja solo la constancia del borrado. Los archivos se borran de Storage después (todo lo que hay bajo `<organización>/`); si falla, quedan en `storage_cleanup_queue` |
| Rectificación | Nombre e idioma en el perfil; datos de la organización en Configuración | RLS: cada uno edita su perfil; los administradores, su organización |
| Oposición, limitación | Por correo a [CORREO DE PRIVACIDAD] | Sin automatizar |

Pruebas: `tests/db/aislamiento.test.ts` (bloque «RGPD»: nadie exporta ni borra
datos de otra persona u organización), `tests/db/rgpd.test.ts` (contenido de
las exportaciones y Edge Functions contra las migraciones reales),
`src/features/privacy/privacidad.test.tsx` (interfaz) y
`tests/e2e/17-rgpd.spec.ts` (de punta a punta, **sin ejecutar todavía**).

Decisiones tomadas por defecto (a revisar):

- Borrar la organización exige **escribir su nombre**, sin periodo de gracia.
  Un periodo de gracia (borrado diferido y recuperable) necesitaría una tarea
  programada; se puede añadir.
- Los comentarios de una persona borrada se quedan en la conversación de la
  organización, sin autor. Su texto puede contener datos personales.
- `ai_usage` (coste, sin datos personales) sobrevive al borrado de la
  organización, como base de la facturación.
- La comprobación de la contraseña al borrar la cuenta abre y cierra una sesión
  aparte; el límite de intentos es el de Supabase Auth.

## 5. Cookies y almacenamiento en el navegador

Comprobado en el código (19/11/2026): **no hay cookies**, ni analítica, ni
publicidad, ni tipografías o scripts de terceros (`index.html` solo carga la
aplicación). En `localStorage`:

| Clave | Para qué | ¿Exenta? |
|---|---|---|
| `sb-<proyecto>-auth-token` | Sesión de Supabase Auth | Sí: técnica, imprescindible |
| `rrss.theme` | Tema elegido por la persona | Sí: preferencia que pide la persona |
| `rrss.last.<usuario>` | Última organización y marca abiertas | Sí, como personalización de la interfaz; es la más discutible: [CONFIRMAR CON EL ABOGADO] |
| `rrss.brandDraft.<organización>` | Borrador del asistente de alta de marca | Sí: lo que escribe la persona, para no perderlo |
| `rrss.pendingInvite` | Invitación abierta antes de iniciar sesión | Sí: técnica |

Conclusión propuesta: no hace falta aviso de cookies (art. 22.2 LSSI); la
política de cookies lo explica. Si se añade analítica, hará falta
consentimiento previo. Al borrar la cuenta, la aplicación borra sus claves de
ese navegador.

## 6. Contenido generado con IA

`content_versions.ai_generated` y `content_items.ai_generated` (la de la versión
vigente) los calcula la base de datos al guardar cada versión con
`private.content_document_ai_generated(marca, documento)` (migración
20261119411000). Marca la pieza:

- una capa de imagen con origen `generation`;
- una imagen o un logotipo de la biblioteca **de la misma marca** con
  procedencia `ai_generation` (solo la escribe el servidor), o un reel o
  recorte (`media_job`) hecho con ellas, o una imagen exportada de una versión
  marcada;
- `copy.aiGenerated` (el editor lo pone al aplicar un texto redactado con IA) o
  `aiGenerated` en una capa.

El criterio es conservador (un texto de la IA retocado sigue marcado). El
editor enseña «Generado con IA» con el espejo de la función en
`src/features/content/aiLabel.ts`. La **publicación** (Fase 3, otro bloque)
debe leer `content_versions.ai_generated` de la versión exacta que publique para
enviar el aviso de cada red (TikTok `is_aigc`) y la marca legible por máquina.

Pendiente: la herramienta de la agencia (`agency/`) entrega documentos
redactados por una sesión de IA y no pone `copy.aiGenerated`; habría que
decidir si se marcan siempre. Qué etiqueta exige la ley en cada caso es una de
las preguntas al abogado (`docs/06-decisiones-fase-2.md`, apartado 5).

## 7. Pendiente

- Contrato de encargo del tratamiento con los clientes y registro como encargado.
- Política de privacidad (versión 2026-11-20): ya incluye el dictado del navegador,
  Google Drive y Cloudflare R2. Falta avisar en el propio copiloto antes del primer dictado.
- Rellenar los huecos de las páginas legales y que un abogado las revise.
- Plazos de conservación marcados «a decidir»; purga de invitaciones caducadas
  y de anotaciones de `storage_cleanup_queue` de organizaciones borradas (solo
  el servidor puede barrerlas).
- Pedir que se vuelvan a aceptar los documentos cuando cambie su versión (hoy
  la cuenta lo ofrece, pero no bloquea el uso).
- Borrado de copias de seguridad del proveedor: depende de su plazo.
- Exportar organizaciones muy grandes: hoy es una sola llamada; con muchos
  contenidos convendría un trabajo en segundo plano.
