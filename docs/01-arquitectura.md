# Arquitectura objetivo

Principio rector: **una única plataforma, infinitas marcas configurables, sin
desarrollo específico por cliente.** Todo lo que distingue a un cliente de otro
es *dato* (configuración declarativa y versionada), nunca *código*.

## 1. Vista general

```
 Navegador (React + Vite, alojado en Vercel)
      │  sesión del usuario (JWT)            solo claves públicas
      ▼
 Supabase ─────────────────────────────────────────────────────────────
  Auth          usuarios, sesiones, MFA
  Postgres      datos de todos los inquilinos + RLS (aislamiento)
                cola de trabajos, cupos y libro de consumo
  Storage       cubo privado; rutas <organización>/<marca>/…
  Edge Functions  servicio de IA, conectores sociales, programador,
                  webhooks (Stripe, Meta)            ← secretos aquí
  pg_cron       despierta al programador y a las automatizaciones
      │
      ▼
 Trabajador de medios (contenedor aparte, Fase 2–3)
  render de imagen (Chromium), vídeo (ffmpeg): reclama trabajos de la cola
      │
      ▼
 Proveedores externos: modelos de IA · redes sociales · Stripe · correo
```

## 2. Dónde se ejecuta cada cosa

| Qué | Dónde | Por qué |
|---|---|---|
| Interfaz | Vercel (estático) | Despliegues por rama, vistas previas, CDN. |
| Lectura y escritura de datos del usuario | Navegador → Supabase, bajo RLS | Sin servidor intermedio que mantener; la seguridad está en la base de datos. |
| Reglas de negocio (invitar, roles, versionar, reservar cupo, reclamar trabajo) | Funciones SQL | Atómicas y junto a los datos. |
| Llamadas a IA, OAuth y publicación en redes | Edge Functions | Necesitan secretos y terminan en segundos. |
| Vídeo y render pesado | Trabajador en contenedor | Superan los límites de tiempo y CPU de una función. Nunca se deja una función «esperando». |
| Tareas periódicas | `pg_cron` → Edge Function | Un único reloj, dentro de la base de datos. |

## 3. Multi-tenancy

- **Base de datos compartida, esquema compartido, aislamiento por RLS.** Un
  proyecto de Supabase por entorno, no por cliente.
- Jerarquía **organización → marcas**. Una empresa es una organización con una
  marca; una agencia es una organización con muchas.
- Un usuario puede estar en varias organizaciones con roles distintos.
- Dos niveles de rol: en la organización (`owner`, `admin`, `member`) y en cada
  marca (`manager`, `editor`, `reviewer`, `client`, `viewer`).
- El superadministrador de la plataforma **no** se salta la RLS: consulta
  resúmenes mediante funciones específicas y auditables.

Detalle en [02-modelo-de-datos.md](02-modelo-de-datos.md).

**Escalabilidad comercial** (más clientes sin programar): alta por asistente,
configuración en JSON exportable e importable, perfiles de marca versionados,
planes y cuotas como datos.

**Escalabilidad técnica** (más carga sin degradar): políticas RLS evaluadas una
vez por consulta, índices por marca y fecha, paginación en todas las listas,
trabajos asíncronos con cola, almacenamiento con URL firmadas, y cupos por
organización para que un cliente no agote los recursos de los demás.

## 4. Trabajos asíncronos (Fase 2 en adelante)

Una sola tabla de trabajos en Postgres, con el patrón ya probado en el panel de
Casa Tomás:

- reclamar con `FOR UPDATE SKIP LOCKED` y una **reserva con caducidad**;
- **clave de idempotencia** por trabajo: reintentar no duplica;
- reintentos con espera creciente y un máximo; después, estado `fallido` visible;
- estados consultables en tiempo real (Supabase Realtime) para la interfaz;
- cancelación y prioridad por plan.

Se elige una cola en Postgres frente a un servicio de colas externo porque
mantiene los trabajos en la misma transacción que los datos y no añade otro
proveedor. Contrapartida: si el volumen crece mucho habrá que mover la cola a un
servicio dedicado; el contrato (reclamar, terminar, fallar) lo permite.

## 5. Servicio de IA (Fase 2)

Un único punto de entrada para toda la IA del producto. El código vive en
`supabase/functions/_shared/ai/`: `contract.ts` (el contrato, sin nada de ningún
proveedor), `service.ts` (reservar → generar → registrar) y
`simulated-provider.ts` (proveedor simulado, solo para pruebas). Es TypeScript
sin dependencias, de modo que las pruebas lo ejecutan tal cual contra la base de
datos. La parte de texto (adaptadores reales, tareas y la Edge Function
`ai-generate`) está en [ia-texto.md](ia-texto.md): implementada y probada con
simulación, **sin probar contra ningún proveedor real**.

- **Adaptadores por proveedor** tras una interfaz común (texto, visión, imagen,
  vídeo, transcripción, vectores). El resto del producto no sabe qué proveedor
  hay detrás; cambiarlo o añadir otro no toca las pantallas.
- **Registro de modelos** como dato: qué modelo sirve cada tarea, su precio y
  sus alternativas si falla.
- **Contexto de marca recuperado, no volcado**: para cada tarea se eligen las
  secciones del perfil que importan y los fragmentos relevantes de las fuentes
  (búsqueda por vectores con `pgvector`), en vez de enviar todo cada vez.
- **Libro de consumo**: cada llamada registra organización, marca, modelo,
  unidades, coste, latencia, estado y valoración del usuario.
- **Cupo reservado antes de llamar**, de forma atómica en SQL, por organización.
- Tiempos máximos, reintentos, modelo alternativo, cancelación y caché cuando la
  petición es idéntica.
- **Verificador de marca** antes de dar una pieza por buena: tono, expresiones
  prohibidas, colores, formato y requisitos de la red. Las reglas comprobables
  sin IA se comprueban sin IA.

### Agentes

Los agentes son funciones con un conjunto **cerrado** de herramientas. Lo que
puede resolverse con una función determinista no se convierte en agente.

Defensas contra la inyección de instrucciones:

- los documentos y textos del cliente entran siempre como **datos delimitados**,
  nunca como instrucciones;
- ninguna herramienta de agente puede publicar, borrar o gastar: solo proponer;
- «aprobado» es un estado que solo escribe una persona con ese permiso, y la
  base de datos lo impone;
- cada paso queda registrado y puede reanudarse.

## 6. Conectores de redes sociales (Fase 3)

Cada red es un módulo que **declara sus capacidades** (qué formatos publica, si
programa, qué estadísticas da, qué exige de la cuenta). La interfaz se adapta a
lo que el conector dice que puede hacer y avisa cuando algo requiere una acción
manual.

- Solo API oficiales y OAuth. Nunca contraseñas de redes.
- Tokens cifrados en una tabla que el cliente no puede leer, con renovación
  programada y aviso antes de caducar.
- Publicación con cerrojo, idempotencia, reintentos seguros y registro de cada
  intento. **Programado no es publicado**: el estado «publicado» solo se escribe
  con el identificador que devuelve la red.
- Primer conector: **Instagram**, portando el cliente y las reglas del panel.

## 7. Editor y documentos

Una pieza es un **documento con capas** (JSON), no una imagen. El mismo código
lo dibuja en el navegador (vista previa) y en el servidor (resultado final). La
IA propone cambios sobre el documento; el original se conserva y cada cambio es
una versión.

## 8. Seguridad

- RLS en todas las tablas; `anon` sin privilegios; privilegios por columna.
- Funciones privilegiadas con `search_path` fijo y comprobaciones explícitas.
- Claves de servicio solo en Edge Functions y en el trabajador.
- Registro de auditoría que el cliente no puede alterar.
- Validación de tipo y tamaño de archivo en el cliente, en el cubo y en la tabla.
- Cabeceras de seguridad en Vercel.
- Pendiente por fases: MFA, límites de frecuencia en funciones, cifrado de
  tokens, exportación y borrado de datos (RGPD), políticas de retención.

## 9. Entornos y despliegue

| Entorno | Supabase | Vercel | Uso |
|---|---|---|---|
| Desarrollo | proyecto de desarrollo (o base local para pruebas) | vista previa por rama | Trabajo diario |
| Staging | proyecto de staging | rama `staging` | Validar antes de publicar |
| Producción | proyecto de producción | rama `main` | Clientes |

Las migraciones se aplican primero en staging y, tras validarlas, en producción.
Ninguna migración destructiva sin su vuelta atrás y su plan de recuperación.

## 10. Decisiones tomadas y sus contrapartidas

| Decisión | Ventaja | Contrapartida |
|---|---|---|
| Esquema compartido con RLS (no un proyecto por cliente) | Alta de clientes sin operaciones; un solo despliegue | Un fallo de política afectaría a todos: por eso hay pruebas de aislamiento obligatorias |
| Organización → marcas, dos niveles de rol | Sirve igual a un negocio y a una agencia | Más complejo que un rol único |
| Reglas de negocio en funciones SQL | Atómicas, imposibles de saltarse desde el cliente | Lógica repartida entre SQL y TypeScript |
| Perfil de marca como JSON versionado y validado | Evoluciona sin migraciones; exportable | Las consultas por campos internos son menos cómodas |
| Aplicación de una página con Vite (no Next.js) | Simple, misma base que el panel, sin servidor propio | Sin renderizado en servidor (no hace falta: es una herramienta privada) |
| Cola en Postgres | Sin otro proveedor; transaccional | Techo de volumen a largo plazo |
| Código en inglés, interfaz y documentación en español | Nombres estándar de SaaS; preparado para traducir | Dos idiomas en el repositorio |
| Repositorio y base de datos nuevos, sin compartir nada con el panel | Producto independiente; riesgo cero para Casa Tomás | Las piezas valiosas hay que portarlas |

## 11. Relación con los paneles existentes

El producto vive en su propio dominio. Casa Tomás pasa a ser **un cliente más**
(una organización con sus marcas), dado de alta con el mismo asistente o
importando su configuración. El panel actual puede enlazar al producto; su
módulo no se toca hasta que el dueño decida retirarlo.
