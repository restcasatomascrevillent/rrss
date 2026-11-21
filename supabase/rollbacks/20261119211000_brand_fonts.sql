-- Vuelta atrás de 20261119211000_brand_fonts.sql.
-- Los archivos de fuente ya subidos se quedan en el cubo (bórralos a mano si
-- hace falta: rutas `<organización>/<marca>/fonts/`). Los reels ya encolados
-- conservan su `plan.fontPath`.
drop trigger if exists jobs_reel_brand_font on public.jobs;
drop function if exists private.jobs_reel_brand_font();
drop function if exists public.brand_reel_font_info(uuid);
drop function if exists private.brand_reel_font(uuid);

update storage.buckets
set allowed_mime_types = array(
  select t from unnest(allowed_mime_types) t
  where t not in ('font/woff2', 'font/woff', 'font/ttf', 'font/otf')
)
where id = 'brand-media';

drop table if exists public.brand_fonts;
