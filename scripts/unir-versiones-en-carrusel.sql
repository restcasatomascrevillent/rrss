-- Convierte un carrusel montado como VARIAS VERSIONES de una pieza (una
-- diapositiva por versión, como el de la demo antes del documento v4) en UNA
-- versión nueva con una página por cada una de esas versiones, en su orden.
-- docs/publicacion.md, «Convertir un carrusel hecho con varias versiones».
--
-- Qué hace:
--   * Lee las versiones indicadas (documentos de las versiones 1 a 3 del
--     esquema: una lista `layers`) y las pone como páginas de un documento v4:
--     la versión 1.ª de la lista es la página 1, y así.
--   * A cada capa (y a cada grupo) le antepone «s<versión>-» para que los
--     identificadores no se repitan entre páginas (el esquema lo exige).
--   * Lienzo y texto de la publicación: los de la ÚLTIMA versión de la lista.
--     El color de fondo es común a todas las páginas: si las diapositivas tenían
--     fondos distintos, revisa el resultado en el editor (un rectángulo al fondo
--     de cada página lo arregla).
--   * Lo guarda con `save_content_version` como la persona indicada (un editor
--     de la marca), igual que «Guardar versión» en el editor: la pieza vuelve a
--     borrador y el historial conserva las versiones de antes.
--
-- Después, en el editor: comprobar las páginas, «Exportar el carrusel» (una
-- imagen por página), aprobar y programar o «Publicar ahora». Las exportaciones
-- de las versiones viejas no valen para publicar el carrusel.
--
-- Uso: rellena los parámetros, revísalo y ejecútalo entero en el editor SQL del
-- proyecto que toque (rol `postgres`). Es una transacción. Mientras los
-- parámetros sigan con «<…>» falla al convertirlos a uuid y no hace nada.
-- Falla también si alguna versión no existe, si ya es un documento v4 o si las
-- versiones no tienen la misma proporción de lienzo.

begin;

create temp table _unir on commit drop as
select
  '<content_id de la pieza>'::uuid as content_id,
  '<user_id de un editor de la marca>'::uuid as editor_id,
  array[1, 2, 3, 4]::integer[] as versions,               -- versiones = diapositivas, en orden
  'Carrusel de varias páginas (antes, una versión por diapositiva)'::text as note;

do $$
declare
  v_params record;
  v_found integer;
  v_ratios integer;
begin
  select * into v_params from _unir;
  if cardinality(v_params.versions) not between 2 and 10 then
    raise exception 'Hacen falta de 2 a 10 versiones';
  end if;
  select count(*), count(distinct v.data #>> '{canvas,aspectRatio}') into v_found, v_ratios
  from public.content_versions v
  where v.content_id = v_params.content_id and v.version = any (v_params.versions)
    and jsonb_typeof(v.data -> 'layers') = 'array' and not (v.data ? 'pages');
  if v_found <> cardinality(v_params.versions) then
    raise exception 'Alguna versión no existe o ya tiene páginas (documento v4)';
  end if;
  if v_ratios <> 1 then
    raise exception 'Las versiones no tienen la misma proporción de lienzo';
  end if;
end $$;

-- Quién guarda: `save_content_version` comprueba con auth.uid() que es editor
-- de la marca y deja su nombre en la versión, como desde la aplicación.
select set_config('request.jwt.claims',
                  json_build_object('sub', (select editor_id from _unir), 'role', 'authenticated')::text, true);

with params as (select * from _unir),
pages as (
  select jsonb_agg(
           jsonb_build_object(
             'id', 'p' || o.ord,
             'name', 'Diapositiva ' || o.ord,
             'layers', (
               select coalesce(jsonb_agg(
                        l.value
                        || jsonb_build_object('id', left('s' || v.version || '-' || (l.value ->> 'id'), 64))
                        || case when l.value ? 'groupId'
                             then jsonb_build_object('groupId', left('s' || v.version || '-' || (l.value ->> 'groupId'), 64))
                             else '{}'::jsonb end
                        order by l.ordinality), '[]'::jsonb)
               from jsonb_array_elements(v.data -> 'layers') with ordinality l)
           )
           order by o.ord) as list
  from params p
  cross join lateral unnest(p.versions) with ordinality o(version, ord)
  join public.content_versions v on v.content_id = p.content_id and v.version = o.version
),
last_version as (
  select v.data
  from params p
  join public.content_versions v on v.content_id = p.content_id and v.version = p.versions[cardinality(p.versions)]
)
select s.version as nueva_version, jsonb_array_length(s.data -> 'pages') as paginas
from params p, pages, last_version,
     lateral public.save_content_version(
       p.content_id,
       (last_version.data - 'layers') || jsonb_build_object('schemaVersion', 4, 'pages', pages.list),
       4,
       p.note
     ) s;

commit;
