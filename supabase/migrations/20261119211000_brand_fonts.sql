-- Fase 3 · Tipografías de la marca: archivos de fuente (.woff2, .woff, .ttf,
-- .otf) con su familia, peso y estilo.
--
--   * `brand_fonts`: una fila por archivo. Quien la sube declara que tiene
--     licencia para usarla en las publicaciones de la marca
--     (`license_confirmed`, obligatorio): la aplicación no puede comprobarlo.
--   * El cubo `brand-media` admite los tipos de fuente. Los archivos van en
--     `<organización>/<marca>/fonts/` y pesan como mucho 5 MB (comprobado en la
--     tabla: el tope del cubo es uno solo para todos los tipos).
--   * Reels: al encolar un `media.reel.template` con textos y sin tipografía,
--     la base de datos le pone la de la marca (`plan.fontPath`), solo de entre
--     sus archivos .ttf/.otf (FFmpeg no lee .woff ni .woff2 de forma fiable).
--     El cliente no elige la ruta: no puede hacer que el trabajador lea un
--     archivo de otra marca. Sin archivo, el trabajador usa su tipografía de
--     reserva y la aplicación lo dice.

create table public.brand_fonts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Nombre de familia tal como se usará en el editor (CSS) y en el perfil.
  family text not null check (char_length(btrim(family)) between 1 and 100 and family = btrim(family)
                              and family !~ '[\\;{}<>"]'),
  weight integer not null default 400 check (weight between 100 and 900 and weight % 100 = 0),
  style text not null default 'normal' check (style in ('normal', 'italic')),
  format text not null check (format in ('woff2', 'woff', 'ttf', 'otf')),
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (mime_type in ('font/woff2', 'font/woff', 'font/ttf', 'font/otf')),
  bytes bigint not null check (bytes between 1 and 5242880),
  -- Declaración de quien la sube: tiene licencia para usarla en la marca.
  license_confirmed boolean not null check (license_confirmed),
  license_note text check (license_note is null or char_length(license_note) <= 500),
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  check (storage_path like organization_id::text || '/' || brand_id::text || '/fonts/%'),
  check (lower(storage_path) like '%.' || format),
  unique (brand_id, family, weight, style)
);
create index brand_fonts_brand_idx on public.brand_fonts (brand_id, family, weight);

alter table public.brand_fonts enable row level security;

create policy brand_fonts_select on public.brand_fonts for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy brand_fonts_insert on public.brand_fonts for insert to authenticated
  with check (brand_id in (select private.brand_ids_with('manage')) and created_by = (select auth.uid()));
create policy brand_fonts_delete on public.brand_fonts for delete to authenticated
  using (brand_id in (select private.brand_ids_with('manage')));

grant select on public.brand_fonts to authenticated;
grant insert (brand_id, organization_id, family, weight, style, format, storage_path, file_name, mime_type, bytes,
              license_confirmed, license_note) on public.brand_fonts to authenticated;
grant delete on public.brand_fonts to authenticated;
grant all on public.brand_fonts to service_role;

create trigger brand_fonts_audit after insert or delete on public.brand_fonts
  for each row execute function private.audit();

-- ───────────────────────── Tipos de fuente en el cubo ─────────────────────────

update storage.buckets
set allowed_mime_types = allowed_mime_types || array(
  select t from unnest(array['font/woff2', 'font/woff', 'font/ttf', 'font/otf']::text[]) with ordinality u(t, o)
  where t <> all (allowed_mime_types)
  order by o
)
where id = 'brand-media';

-- ─────────────────────────── Tipografía de los reels ───────────────────────────

-- Archivo de fuente de la marca para los reels: solo .ttf/.otf. Primero la
-- familia que el perfil vigente pone en primer lugar; dentro de ella, redonda
-- antes que cursiva y el peso más cercano a 400. Null si no hay ninguno.
create function private.brand_reel_font(p_brand_id uuid) returns public.brand_fonts
language sql stable security definer set search_path = '' as $$
  select f.*
  from public.brand_fonts f
  where f.brand_id = p_brand_id and f.format in ('ttf', 'otf')
  order by
    lower(f.family) = lower(coalesce((
      select bp.data #>> '{visual,fonts,0,family}' from public.brand_profiles bp
      where bp.brand_id = p_brand_id and bp.status = 'active'
    ), '')) desc,
    f.style = 'normal' desc,
    abs(f.weight - 400),
    f.created_at,
    f.id
  limit 1;
$$;

-- Lo que la aplicación enseña antes de encargar: qué tipografía usará el reel.
create function public.brand_reel_font_info(p_brand_id uuid)
returns table (font_id uuid, family text, weight integer, style text, format text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_font public.brand_fonts;
begin
  if p_brand_id is null or p_brand_id not in (select private.brand_ids_with('view')) then
    raise exception 'No tienes acceso a esta marca' using errcode = '42501';
  end if;
  v_font := private.brand_reel_font(p_brand_id);
  if v_font.id is not null then
    return query select v_font.id, v_font.family, v_font.weight, v_font.style, v_font.format;
  end if;
end $$;

create function private.jobs_reel_brand_font() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_font public.brand_fonts;
begin
  if new.brand_id is null
     or jsonb_typeof(new.payload -> 'plan') is distinct from 'object'
     or new.payload #> '{plan,fontPath}' is not null
     or jsonb_typeof(new.payload #> '{plan,texts}') is distinct from 'array'
     or jsonb_array_length(new.payload #> '{plan,texts}') = 0 then
    return new;
  end if;
  v_font := private.brand_reel_font(new.brand_id);
  if v_font.id is not null then
    new.payload := jsonb_set(new.payload, '{plan,fontPath}', to_jsonb(v_font.storage_path));
  end if;
  return new;
end $$;

create trigger jobs_reel_brand_font before insert on public.jobs
  for each row when (new.kind = 'media.reel.template')
  execute function private.jobs_reel_brand_font();

revoke all on function private.brand_reel_font(uuid) from public, anon, authenticated;
revoke all on function private.jobs_reel_brand_font() from public, anon, authenticated;
revoke all on function public.brand_reel_font_info(uuid) from public, anon;
grant execute on function public.brand_reel_font_info(uuid) to authenticated;
