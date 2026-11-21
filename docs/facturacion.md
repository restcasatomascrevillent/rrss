# Planes y facturación (Fase 6)

Estado a 19/11/2026:

| Qué | Estado |
|---|---|
| Planes como datos, suscripción por organización y límites impuestos por la base de datos | Implementado y probado en base de datos (`tests/db/planes.test.ts`, `tests/db/aislamiento.test.ts`) |
| Panel de margen, edición de planes y asignación manual en Plataforma; «Configuración → Plan» | Implementado y probado en componentes (`src/features/billing/planes.test.tsx`); escenario e2e `16-planes` escrito, **sin ejecutar** |
| Stripe: Checkout, portal de cliente y webhook | Escrito contra la documentación oficial y probado con un Stripe simulado y avisos firmados en la prueba (`tests/db/facturacion-stripe.test.ts`). **Sin probar contra Stripe real** (ni en modo de pruebas) |

## Modelo

- `plans`: una fila por plan. Precio y periodo (`price_micros`, `billing_interval`),
  cuotas (`max_brands`, `max_members`, `max_storage_bytes`; vacío = sin límite),
  cupo mensual de IA (`ai_monthly_micros`; 0 = sin IA) y funciones
  (`features`: `ai_text`, `ai_image`, `ai_video`, `reels`, `publishing`). Además:
  `is_public` (se contrata en línea), `is_default` (exactamente uno), `active`
  (se puede asignar) y `stripe_price_id`.
- `subscriptions`: una fila por organización (se crea sola). `source` dice quién
  la mantiene: `default` (sin plan asignado), `manual` (superadministrador) o
  `stripe` (el webhook). `custom_price_micros` es el precio pactado de un cliente
  sin Stripe.
- `billing_events`: cada aviso de Stripe recibido, por su id, con lo que se hizo
  (`applied`, `ignored` y el motivo). Solo lo leen los superadministradores.

**Plan efectivo** = el de la suscripción si está `active`, `trialing` o
`past_due`; si no (sin plan, cancelada, impagada, sin completar, en pausa), el
plan por defecto. Bajar de plan no borra nada: lo que ya hay se queda, pero no se
puede crear más hasta liberar sitio.

### Límites (los impone la base de datos)

| Límite | Dónde | Error |
|---|---|---|
| Marcas activas (las archivadas no cuentan) | crear o desarchivar una marca | `PL001` |
| Personas | invitar (las invitaciones pendientes ocupan plaza) y aceptar | `PL001` |
| Almacenamiento (biblioteca + fuentes) | lo que sube una persona; encargar un reel o un recorte, o una imagen con IA, si ya está lleno | `PL001` |
| Reels | encargar un reel | `PL002` |
| Imagen y vídeo con IA, texto con IA | reservar cupo de IA | `PL002` |
| Cupo mensual de IA | reservar cupo de IA | `AI002` (sin cupo) / `AI001` (agotado) |

Los mensajes están escritos para personas («Has llegado al límite de marcas
activas de tu plan «Prueba»: 1 de 1. Archiva una marca o cambia de plan.») y el
`DETAIL` lleva las cifras en JSON. La clave de servicio no tiene límites de plan
(operaciones de la plataforma). Lo que da de alta el servidor (resultados de
reels, imágenes generadas) se comprueba al encargarlo y puede rebasar el
almacenamiento en lo que ocupe ese resultado.

Para una función nueva (por ejemplo, la publicación de la Fase 3):
`perform private.require_plan_feature(organization_id, 'publishing');` en la
función que la inicia.

### Cupo de IA

El cupo sale del plan, salvo que un superadministrador lo sobrescriba
(`admin_set_ai_quota`, fila en `usage_quotas`). `admin_clear_ai_quota` retira la
sobrescritura y vuelve a mandar el plan. Las reservas se serializan ahora con la
fila de `subscriptions`, que existe siempre.

### Sin plan asignado

Una organización nueva nace en el plan por defecto, hoy **«Prueba»**: una marca,
dos personas, 500 MB, solo texto con IA y **cupo de IA 0** (es decir, sin IA
hasta que contrate un plan o la plataforma le dé cupo). Es el comportamiento
seguro: nadie gasta dinero de IA ni ocupa recursos sin un plan. El plan por
defecto se cambia en Plataforma («Hacer por defecto»).

### Organizaciones que ya existían

La migración les asigna a mano el plan **«Heredado»**: sin límites de marcas,
personas ni almacenamiento, con todas las funciones y sin cupo de IA del plan.
Conservan su cupo sobrescrito si lo tenían. Es exactamente lo que tenían antes;
el superadministrador las pasa a su plan cuando quiera.

### Planes iniciales (propuesta, editable)

| Plan | Precio/mes | Marcas | Personas | Almacenamiento | IA/mes | Funciones | En línea |
|---|---|---|---|---|---|---|---|
| Prueba (por defecto) | 0 | 1 | 2 | 500 MB | 0 | texto | no |
| Básico | 29 | 1 | 3 | 5 GB | 5 | texto | sí |
| Profesional | 79 | 5 | 10 | 25 GB | 25 | texto, imagen, reels, publicación | sí |
| Agencia | 199 | 25 | 30 | 100 GB | 100 | texto, imagen, reels, publicación | sí |
| Enterprise | a medida | sin límite | sin límite | sin límite | 500 | todas | no |
| Heredado | 0 | sin límite | sin límite | sin límite | 0 | todas | no |

Precios y cuotas en unidades de la moneda de cuenta. **Son propuestas**: los
decide el dueño y se cambian en Plataforma → Planes sin desplegar.

## Moneda y margen

La moneda de cuenta sigue **sin decidir** (`VITE_AI_ACCOUNT_CURRENCY`; sin ella
la interfaz dice «unidades de cuenta»). Supuesto de este bloque: **los precios
de los planes y los costes de IA están en la misma moneda de cuenta**, en micros.
Solo así ingresos − coste = margen tiene sentido. Al decidir la moneda:

1. Fijar `VITE_AI_ACCOUNT_CURRENCY` y la tabla de precios de IA en esa moneda.
2. Escribir los precios de los planes en esa misma moneda.
3. Crear en Stripe los precios en esa moneda (Stripe cobra en la moneda del
   precio; no convierte nada aquí).

El margen del panel es **de catálogo**: precio del plan (o pactado) llevado a un
mes (los anuales, entre 12), para suscripciones `active` o `past_due`; las que
están en periodo de prueba, canceladas o sin plan suman 0. Lo cobrado de verdad
(impuestos, descuentos, prorrateos, devoluciones) está en Stripe.

## Stripe

Todo el pago ocurre en Stripe: la aplicación nunca ve tarjetas ni datos de
facturación. Interruptor de la interfaz: **`VITE_BILLING_ENABLED=true`**; sin
él no aparece nada de pago (ni precios para el cliente, ni «Contratar», ni el
portal).

| Función | Qué hace |
|---|---|
| `billing-checkout` | Propietario o administrador → URL de Stripe Checkout (`mode=subscription`) del plan elegido. La organización va en `client_reference_id` y en los metadatos de la sesión y de la suscripción. Si ya paga, responde 409 y la interfaz manda al portal |
| `billing-portal` | Propietario o administrador → URL del portal de cliente (cambiar de plan o de tarjeta, facturas, cancelar) |
| `billing-webhook` | Verifica `Stripe-Signature` (HMAC-SHA256 de `t.cuerpo`, 5 minutos de tolerancia, varias `v1` al rotar el secreto), lee de la API el **estado actual** de la suscripción (el orden de los avisos no está garantizado) y lo guarda con `billing_apply_stripe_event`, idempotente por id de evento. 2xx si está hecho, repetido o ignorado; 400 si la firma no vale; 5xx para que Stripe reintente |

Avisos que hay que suscribir en Stripe: `checkout.session.completed`,
`customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `customer.subscription.paused`,
`customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`.

### Variables (secretos de las funciones; no van a `.env` del navegador)

**Desde la interfaz:** la clave secreta, el secreto del webhook y la dirección
de la aplicación se pueden meter en **Plataforma → Integraciones → Stripe**. Se
guardan cifradas en Supabase Vault (migración `20261120010000`), no se vuelven a
ver y mandan sobre las variables de abajo; las tres funciones las leen sin
redesplegar (caché de 30 s). «Probar conexión» lee la cuenta
(`GET /v1/account`: no crea clientes ni cobros); el secreto del webhook solo se
puede comprobar con el primer aviso de Stripe. «Contratar» y el portal salen si
`VITE_BILLING_ENABLED=true` **y** el servidor tiene clave, secreto del webhook y
dirección de la aplicación.

| Variable | Dónde | Qué es |
|---|---|---|
| `STRIPE_SECRET_KEY` | las tres funciones | Clave secreta de Stripe (`sk_test_…` en pruebas). Mejor una clave restringida con permisos de escritura en Checkout Sessions y Customer Portal y de lectura en Subscriptions |
| `STRIPE_WEBHOOK_SECRET` | `billing-webhook` | Secreto del punto de conexión (`whsec_…`). Varios separados por comas mientras se rota |
| `BILLING_APP_URL` | `billing-checkout`, `billing-portal` | Dirección de la aplicación (https; http solo en localhost), para volver de Stripe a «Configuración → Plan» |
| `BILLING_ALLOWED_ORIGIN` | `billing-checkout`, `billing-portal` | Origen permitido para CORS (opcional; por defecto, cualquiera: la sesión va en cabecera) |
| `VITE_BILLING_ENABLED` | aplicación | `true` para enseñar contratar y el portal |

### Qué falta para activarlo (por este orden)

1. Cuenta de Stripe de la empresa (la abre el dueño) y decidir la moneda.
2. En modo de pruebas: un producto y un precio recurrente por cada plan en línea;
   copiar cada `price_…` en Plataforma → Planes → «Precio de Stripe».
3. Configurar el portal de cliente en el panel de Stripe (qué planes se pueden
   cambiar, cancelación al final del periodo…).
4. Desplegar `billing-checkout`, `billing-portal` y `billing-webhook` en staging
   con los secretos de arriba (o metiéndolos en Plataforma → Integraciones → Stripe); dar de alta el punto de conexión
   `https://<proyecto>.supabase.co/functions/v1/billing-webhook` con los avisos
   listados.
5. Probar de punta a punta con tarjetas de prueba de Stripe (alta, impago con la
   tarjeta de rechazo, cambio de plan en el portal, cancelación) y revisar
   `billing_events`. Hasta entonces, todo esto es **código sin probar contra
   Stripe real**.
6. `VITE_BILLING_ENABLED=true` en el despliegue.

Pendiente aparte: impuestos (Stripe Tax o tipos fijos), datos fiscales en la
factura, periodo de prueba en Stripe y avisos por correo de impago.
