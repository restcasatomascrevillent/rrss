# Plan por fases

Cada fase entrega algo utilizable y comprobable. Complejidad relativa:
S (días), M (1–2 semanas), L (3–5 semanas), XL (más de un mes), contando
desarrollo asistido y validación. Son estimaciones, no compromisos.

| Fase | Entrega | Complejidad | Estado |
|---|---|---|---|
| 0 | Auditoría, arquitectura, modelo de datos, diseño, plan | S | Hecha |
| 1 | Núcleo SaaS multiempresa | M | Código hecho; pendiente de desplegar en el Supabase nuevo |
| 2 | Estudio creativo con IA | L | Empezada: cimientos (consumo, cupos, cola, servicio con proveedor simulado). Sin proveedor real ni interfaz |
| 3 | Calendario, aprobaciones y publicación real | L | Pendiente |
| 4 | Planificación, agentes y automatizaciones | L | Pendiente |
| 5 | Analítica e informes | M | Pendiente |
| 6 | Planes, cuotas, facturación y operación | L | Pendiente |

## Fase 1 · Núcleo SaaS

Sesión, organizaciones, marcas, roles, RLS, asistente de alta, perfil de marca
versionado, biblioteca, equipo e invitaciones, auditoría, panel inicial,
exportar e importar configuración.

**Aceptación**

- [x] Dos organizaciones independientes no ven ni modifican datos de la otra
      (tablas y almacenamiento), probado contra las migraciones reales.
- [x] Roles por organización y por marca con sus límites, probados.
- [ ] Alta de dos marcas desde la interfaz en el entorno desplegado. *Bloqueado:
      falta el proyecto nuevo de Supabase.*
- [ ] Prueba de extremo a extremo en navegador contra ese entorno.

## Fase 2 · Estudio creativo IA

Servicio de IA con adaptadores, registro de generaciones, cupos y coste por
organización; procesado de las fuentes de marca (texto, vectores, perfil
propuesto para revisar); textos y variantes por red; propuestas visuales;
documento editable por capas con versiones; verificador de marca; cola de
trabajos y trabajador de medios.

**Aceptación**: generar una publicación coherente con el perfil de dos marcas
distintas; editarla y guardarla; ver la comprobación de marca; consultar el
coste de IA por organización; un cupo agotado detiene la generación con un
mensaje claro; pruebas de los flujos con proveedores simulados.

**Decisiones del dueño antes de empezar**: proveedor o proveedores de IA y
presupuesto mensual; dónde alojar el trabajador de medios.

**Hecho sin esperar a esas decisiones** (16/11/2026; solo base de datos y
servicio, probado con proveedor simulado):

- [x] Registro de generaciones, libro de consumo y cupo mensual por
      organización, impuesto por la base de datos.
- [x] Un cupo agotado detiene la generación con un mensaje claro, también con
      reservas simultáneas.
- [x] Coste de IA por organización y periodo (función SQL; falta la pantalla).
- [x] Cola de trabajos: idempotencia, reserva con caducidad, reintentos,
      cancelación.
- [x] Contrato del servicio de IA y flujo completo con proveedor simulado.
- [ ] Todo lo demás de la fase: adaptador real, Edge Function, fuentes de marca,
      textos, propuestas visuales, editor, verificador, trabajador de medios.

## Fase 3 · Calendario y publicación

Calendario (mes, semana, día, campaña, red) con arrastrar y soltar; estados de
idea a publicado; aprobaciones individuales y por lotes; comentarios; conector
de Instagram con OAuth y tokens cifrados; programador con cerrojo, idempotencia,
reintentos y registro de intentos.

**Aceptación**: conectar una cuenta real, aprobar y publicar una imagen y verla
en la red con su identificador guardado; un fallo provocado no duplica; un
contenido sin aprobar no se publica aunque esté programado.

**Dependencia externa**: aplicación de Meta propia con verificación de empresa y
revisión de permisos. El plazo lo marca Meta; conviene iniciarlo cuanto antes.

## Fase 4 · IA avanzada y automatizaciones

Estratega (observado / respaldado por datos / hipótesis / acciones),
planificación del calendario por instrucción, generación por lotes, coordinador
con pasos visibles y reanudables, motor de automatizaciones (disparador,
condiciones, acciones, historial) que respeta las aprobaciones.

**Aceptación**: «prepara la semana que viene» produce un plan explicado y
borradores pendientes de aprobar; ninguna automatización publica por su cuenta;
un documento con instrucciones maliciosas no cambia el comportamiento del agente.

## Fase 5 · Analítica

Capturas periódicas por red, panel comparativo, informes en PDF, analista que
distingue dato de hipótesis y dice qué no se puede medir.

**Aceptación**: las cifras coinciden con las de la red para una cuenta real; el
informe se genera sin intervención.

## Fase 6 · Comercialización y escalado

Planes (Básico, Profesional, Agencia, Enterprise) como datos, derechos y cuotas,
Stripe, panel de superadministración completo (coste y margen por cliente,
trabajos, errores, integraciones, *feature flags*), observabilidad y alertas,
MFA, exportación y borrado de datos, copias y recuperación ensayada.

**Aceptación**: saber cuánto cuesta y cuánto deja cada cliente; cambiar un plan
cambia sus límites sin desplegar.

## Criterios imprescindibles del encargo

| # | Criterio | Fase | Estado |
|---|---|---|---|
| 1 | Crear una empresa sin escribir código | 1 | Implementado |
| 2 | Configurarla con su identidad de marca | 1 | Implementado |
| 3 | Subir manual corporativo y fotografías | 1 | Implementado (el análisis del manual con IA es Fase 2) |
| 4 | Acceder con permisos adecuados | 1 | Implementado y probado en base de datos |
| 5 | Generar publicaciones coherentes con la marca | 2 | Pendiente |
| 6 | Editar y guardar contenidos | 2 | Pendiente |
| 7 | Organizar un calendario editorial | 3 | Pendiente |
| 8 | Conectar una cuenta social | 3 | Pendiente (depende de Meta) |
| 9 | Aprobar y publicar con una integración real | 3 | Pendiente |
| 10 | Consultar el historial | 1–3 | Parcial: auditoría y versiones de marca |
| 11 | Administrar varias empresas desde una cuenta de agencia | 1 | Implementado |
| 12 | Ningún cliente accede a datos ajenos | 1 | Probado en base de datos |
| 13 | Coste de IA por empresa | 2 | Parcial: registrado y consultable por función SQL, probado; sin pantalla y sin proveedor real |
| 14 | Añadir marcas sin tocar la lógica | 1 | Implementado |
| 15 | Desplegar sin interrumpir | 1–6 | Circuito definido; pendiente de montar los entornos |

«Implementado» significa código escrito y verificado con pruebas unitarias y de
base de datos; no se da por probado de extremo a extremo hasta ejecutarlo contra
el entorno desplegado.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Revisión de la aplicación de Meta lenta o denegada | Empezar el trámite ya; mientras, modo «preparar y descargar» declarado como tal |
| Coste de IA mayor que el ingreso por cliente | Cupos desde la Fase 2, coste por organización visible, modelos por tarea |
| Fuga de datos entre clientes | RLS + pruebas de aislamiento obligatorias en cada cambio de esquema |
| Vídeo: coste y tiempos | Trabajador aparte, cola con prioridades, límites por plan |
| Dependencia de un proveedor de IA | Adaptadores y registro de modelos |
| Derechos de imágenes, música y tipografías | Derechos de uso en cada recurso; no se incluyen recursos de terceros en el producto |
| Alcance: muchas funciones a medias | Fases verticales con criterios de aceptación; el menú solo muestra lo terminado |

## Dependencias externas y costes

| Servicio | Para qué | Coste |
|---|---|---|
| Supabase | Base de datos, sesión, archivos, funciones | Plan de pago fijo mensual por proyecto para producción (copias, sin pausas, archivos grandes); el gratuito vale para empezar |
| Vercel | Alojar la interfaz | El plan gratuito no permite uso comercial; producción requiere plan de pago |
| Proveedor(es) de IA | Texto, imagen, vídeo, transcripción | Variable por uso; es el coste que hay que medir por cliente |
| Alojamiento del trabajador de medios | Render y vídeo | Variable por tiempo de cómputo |
| Meta (y resto de redes) | Publicación y estadísticas | Sin coste de API; exige verificación |
| Stripe | Cobros | Comisión por transacción |
| Correo transaccional | Invitaciones y avisos | Bajo, por volumen |
| Dominio | Dirección propia del producto | Anual |

Los importes concretos dependen de los planes vigentes de cada proveedor y se
confirmarán con el dueño antes de contratar nada.

## Plan de migración de Casa Tomás

1. El módulo del panel sigue funcionando sin cambios.
2. Con las Fases 1–3 en producción, Casa Tomás se da de alta como una
   organización con sus dos marcas, importando su configuración.
3. Se suben sus recursos a la biblioteca y se conecta su cuenta de Instagram
   desde el propio producto.
4. Periodo en paralelo; cuando el dueño lo decida, el panel enlaza al producto
   y su módulo se retira en un cambio aparte.
