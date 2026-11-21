# Reglas para Claude en este repositorio

Plataforma SaaS multiempresa de gestión de redes sociales con IA. Contexto y
decisiones en `docs/`; el punto en que está el trabajo, en `docs/ESTADO.md`
(**actualízalo al terminar cada bloque**).

- **Otros repositorios y cuentas.** No se toca `admin-casatomas` ni
  `web-casatomas` (ni siquiera para «arreglar algo de paso») ni ningún proyecto
  de Supabase de Casa Tomás. Supabase usa una cuenta propia (Oficiosos). En
  Vercel, por decisión del dueño (18/11/2026), el proyecto `rrss` vive en el
  equipo `casa-tomas` junto a los del restaurante: tócalo solo a él, nunca
  `web-casatomas`, `admin-casatomas` ni `touza-casatomas`.
- **Sin código por cliente.** Nada de nombres, colores, textos o condiciones de
  un cliente concreto en el código. Lo que distingue a un cliente es configuración.
- **Aislamiento.** Tabla nueva = RLS + políticas + privilegios explícitos +
  casos en `tests/db/aislamiento.test.ts`. Función `SECURITY DEFINER` con
  `set search_path = ''`. Migración nueva = su vuelta atrás en `supabase/rollbacks/`.
- **Secretos.** Solo claves públicas en variables `VITE_`. La clave de servicio
  y las de proveedores viven en funciones del servidor.
- **Honestidad del producto.** No se simula nada: programado no es publicado,
  lo que no existe no sale en el menú, y la documentación distingue implementado,
  probado, pendiente y bloqueado.
- **Idioma.** Código (identificadores, tablas) en inglés; interfaz, comentarios
  y documentación en español.
- **Antes de subir:** `npm run typecheck`, `npm run lint`, `npm test`,
  `npm run test:db` y `npm run build` en verde.
- **Ramas.** `feature/*` o `fix/*` con PR a `staging`; a `main` solo con PR de
  versión aceptado por el dueño. Sin `push --force`. Migraciones primero en
  staging; en producción solo cuando el dueño lo pida.
- **Commits** con tipo convencional (`feat(…)`, `fix(…)`…) y, si cambia un
  comportamiento, líneas `Antes: …` / `Ahora: …`.
