-- Fase 3 · Publicaciones programadas y registro de intentos (docs/publicacion.md).
--
--   * `scheduled_publications` es una pieza puesta en el calendario: cuándo, en
--     qué cuenta, qué versión aprobada y qué recursos exportados de esa versión.
--     El calendario es una vista de esta tabla.
--   * Estados: planned (en el calendario, todavía sin armar: `hold_reason` dice
--     por qué) → scheduled (armada: saldrá a su hora) → publishing → published
--     (solo con el identificador que devuelve la red), o failed (con el motivo;
--     se puede reintentar) o cancelled.
--   * REGLA DURA, impuesta aquí y no en la interfaz: lo que no está aprobado no
--     se publica aunque esté programado. Una publicación solo está «scheduled»
--     si la pieza está aprobada, su versión vigente es la programada, no está
--     archivada, la cuenta está viva y los recursos son exportaciones de esa
--     versión. Si la pieza cambia (otra versión, se retira la aprobación, se
--     archiva), un disparador la devuelve a «planned» hasta reaprobar; y aunque
--     algo se saltara el disparador, un segundo disparador impide pasar a
--     «publishing» sin cumplir la regla (ni siquiera con la clave de servicio).
--   * Una pieza se programa una sola vez (salvo cancelada): un fallo se
--     reintenta sobre la misma fila, que recuerda el contenedor de la red ya
--     creado, así un reintento nunca publica dos veces.
--   * Las personas no escriben estas tablas: todo pasa por funciones que
--     comprueban la capacidad `edit` sobre la marca. El publicador (servidor)
--     usa las suyas (migración 20261119040000).

create type public.publication_status as enum ('planned', 'scheduled', 'publishing', 'published', 'failed', 'cancelled');

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.scheduled_publications (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  content_id uuid not null,
  -- Versión aprobada que se publicará (null mientras la pieza no se ha aprobado).
  content_version integer check (content_version is null or content_version > 0),
  social_account_id uuid,
  -- Copia de la red y el formato de la pieza (la mantiene un disparador), para filtrar.
  network text not null check (network ~ '^[a-z][a-z0-9_]{0,31}$'),
  format text not null check (format ~ '^[a-z][a-z0-9_]{0,31}$'),
  scheduled_at timestamptz not null,
  -- Recursos de la biblioteca, en orden (carrusel).
  media_asset_ids uuid[] not null default '{}' check (cardinality(media_asset_ids) <= 20),
  status public.publication_status not null default 'planned',
  -- Por qué no está armada (solo en «planned»).
  hold_reason text check (hold_reason in ('not_approved', 'content_changed', 'content_archived', 'no_account',
                                          'account_disconnected', 'account_needs_reauth', 'no_media',
                                          'invalid_media', 'unsupported_format')),
  -- Sube en cada reintento manual: forma parte de la clave de idempotencia del trabajo.
  generation integer not null default 1 check (generation > 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error_code text check (last_error_code is null or char_length(last_error_code) <= 100),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  -- Contenedor de la red (Instagram: creation_id). Se guarda ANTES de publicar:
  -- es lo que se mira antes de crear otro o de volver a publicar.
  container_id text check (container_id is null or char_length(container_id) between 1 and 100),
  container_created_at timestamptz,
  external_id text check (external_id is null or char_length(external_id) between 1 and 100),
  external_url text check (external_url is null or (char_length(external_url) <= 2000 and external_url ~* '^https?://')),
  published_at timestamptz,
  -- Cerrojo del publicador: quién la tiene (el trabajo de la cola) y hasta cuándo.
  locked_by text check (locked_by is null or char_length(locked_by) between 1 and 200),
  locked_until timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  foreign key (content_id, brand_id, organization_id)
    references public.content_items (id, brand_id, organization_id) on delete cascade,
  foreign key (content_id, content_version) references public.content_versions (content_id, version) on delete cascade,
  -- La cuenta es de la misma marca.
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id),
  unique (id, brand_id, organization_id),
  check (status not in ('scheduled', 'publishing', 'published')
         or (content_version is not null and social_account_id is not null and cardinality(media_asset_ids) > 0)),
  check ((hold_reason is not null) = (status = 'planned')),
  -- «Publicado» solo con el identificador de la red.
  check ((status = 'published') = (external_id is not null and published_at is not null)),
  check ((locked_by is null) = (locked_until is null))
);
create index scheduled_publications_brand_time_idx on public.scheduled_publications (brand_id, scheduled_at);
create index scheduled_publications_due_idx on public.scheduled_publications (scheduled_at) where status = 'scheduled';
create index scheduled_publications_content_idx on public.scheduled_publications (content_id);
create index scheduled_publications_account_idx on public.scheduled_publications (social_account_id);
create index scheduled_publications_assets_idx on public.scheduled_publications using gin (media_asset_ids);
-- Una pieza se programa una vez: lo fallido se reintenta, no se duplica.
create unique index scheduled_publications_one_per_content_idx on public.scheduled_publications (content_id)
  where status <> 'cancelled';

-- Registro de cada pasada del publicador por una publicación.
create table public.publication_attempts (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  attempt_no integer not null check (attempt_no > 0),
  job_id uuid,
  worker text check (worker is null or char_length(worker) <= 200),
  -- started: en curso · waiting: la red aún procesa el medio · deferred: aplazada
  -- (cupo de la red) · published / recovered (ya estaba publicada: no se repite) ·
  -- retrying: falló y se reintentará · failed: falló del todo · not_ready: al
  -- llegar su hora no cumplía la regla de aprobación y no se publicó.
  outcome text not null default 'started'
    check (outcome in ('started', 'waiting', 'deferred', 'published', 'recovered', 'retrying', 'failed', 'not_ready')),
  container_id text check (container_id is null or char_length(container_id) <= 100),
  external_id text check (external_id is null or char_length(external_id) <= 100),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (publication_id, brand_id, organization_id)
    references public.scheduled_publications (id, brand_id, organization_id) on delete cascade,
  unique (publication_id, attempt_no)
);
create index publication_attempts_publication_idx on public.publication_attempts (publication_id, attempt_no desc);
create index publication_attempts_brand_idx on public.publication_attempts (brand_id);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Formatos que el publicador sabe publicar hoy.
create function private.publication_format_supported(p_network text, p_format text) returns boolean
language sql immutable set search_path = '' as $$
  select p_network = 'instagram' and p_format in ('post', 'carousel', 'reel');
$$;

-- ¿Valen estos recursos para esta pieza, versión y formato? Null si valen; si
-- no, 'no_media' (faltan) o 'invalid_media'.
--   post: 1 imagen JPEG · carousel: de 2 a 10 imágenes JPEG · reel: 1 vídeo MP4 o MOV.
--   Las imágenes tienen que ser exportaciones de ESA pieza y ESA versión
--   (media_assets.provenance, 20261118120000). El vídeo de un reel lo monta el
--   trabajador de medios y no sale del documento: vale cualquier vídeo de la marca.
create function private.publication_media_problem(
  p_brand_id uuid, p_content_id uuid, p_version integer, p_format text, p_asset_ids uuid[]
) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_count integer := coalesce(cardinality(p_asset_ids), 0);
  v_found integer;
  v_ok integer;
begin
  if v_count = 0 then
    return 'no_media';
  end if;
  select count(*),
         count(*) filter (where
           case when p_format = 'reel' then
             a.kind = 'video' and a.mime_type in ('video/mp4', 'video/quicktime')
           else
             a.kind = 'image' and a.mime_type = 'image/jpeg'
             and a.provenance ->> 'type' = 'export'
             and a.provenance ->> 'content_id' = p_content_id::text
             and coalesce(a.provenance ->> 'version', '') = coalesce(p_version::text, '-')
             -- Exportada con cambios sin guardar: no es la versión aprobada.
             and coalesce(a.provenance ->> 'unsaved_changes', 'false') = 'false'
           end)
  into v_found, v_ok
  from public.media_assets a
  where a.id = any (p_asset_ids) and a.brand_id = p_brand_id;

  if v_found <> v_count or v_ok <> v_count then
    return 'invalid_media';
  end if;
  if (p_format = 'post' and v_count <> 1) or (p_format = 'reel' and v_count <> 1)
     or (p_format = 'carousel' and v_count not between 2 and 10) then
    return 'invalid_media';
  end if;
  return null;
end $$;

-- Por qué una publicación no se puede publicar ahora mismo; null si cumple la
-- regla. Es el único sitio donde se define «lista para publicar».
create function private.publication_hold_reason(p_pub public.scheduled_publications) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_item public.content_items;
  v_account public.social_accounts;
begin
  select * into v_item from public.content_items c where c.id = p_pub.content_id;
  if not found then
    return 'content_changed';
  end if;
  if v_item.archived_at is not null then
    return 'content_archived';
  end if;
  if v_item.status <> 'approved' then
    return 'not_approved';
  end if;
  if p_pub.content_version is null or p_pub.content_version <> v_item.current_version
     or (p_pub.network, p_pub.format) is distinct from (v_item.network, v_item.format) then
    return 'content_changed';
  end if;
  if not private.publication_format_supported(v_item.network, v_item.format) then
    return 'unsupported_format';
  end if;
  if p_pub.social_account_id is null then
    return 'no_account';
  end if;
  select * into v_account from public.social_accounts a where a.id = p_pub.social_account_id;
  if not found or v_account.network <> v_item.network then
    return 'no_account';
  end if;
  if v_account.status = 'disconnected' then
    return 'account_disconnected';
  end if;
  if v_account.status = 'needs_reauth' then
    return 'account_needs_reauth';
  end if;
  return private.publication_media_problem(p_pub.brand_id, p_pub.content_id, p_pub.content_version, p_pub.format,
                                           p_pub.media_asset_ids);
end $$;

-- Vuelve a evaluar las publicaciones en el calendario (planned o scheduled) de
-- una pieza, de una cuenta o una concreta: las arma o las detiene. Si la pieza
-- se aprueba y la publicación aún no tenía versión, adopta la aprobada.
create function private.publication_refresh(
  p_content_id uuid default null, p_account_id uuid default null, p_publication_id uuid default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_item public.content_items;
  v_reason text;
begin
  for v_pub in
    select * from public.scheduled_publications p
    where p.status in ('planned', 'scheduled')
      and (p_content_id is null or p.content_id = p_content_id)
      and (p_account_id is null or p.social_account_id = p_account_id)
      and (p_publication_id is null or p.id = p_publication_id)
    for update
  loop
    select * into v_item from public.content_items c where c.id = v_pub.content_id;
    v_pub.network := v_item.network;
    v_pub.format := v_item.format;
    if v_pub.content_version is null and v_item.status = 'approved' then
      v_pub.content_version := v_item.current_version;
    end if;
    v_reason := private.publication_hold_reason(v_pub);
    update public.scheduled_publications p
    set network = v_pub.network, format = v_pub.format, content_version = v_pub.content_version,
        status = case when v_reason is null then 'scheduled'::public.publication_status else 'planned' end,
        hold_reason = v_reason
    where p.id = v_pub.id
      and (p.network, p.format, p.content_version, p.status, p.hold_reason)
          is distinct from (v_pub.network, v_pub.format, v_pub.content_version,
                            case when v_reason is null then 'scheduled'::public.publication_status else 'planned' end,
                            v_reason);
  end loop;
end $$;

-- Guarda de la regla dura: ninguna publicación entra en «publishing» sin estar
-- lista, nada pasa a «published» sin haber estado publicándose, y lo publicado
-- no cambia de estado. Vale para todos los roles, también la clave de servicio.
create function private.scheduled_publications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and old.status = 'published' and new.status <> 'published' then
    raise exception 'Una publicación ya publicada no cambia de estado' using errcode = 'PB002';
  end if;
  if new.status in ('scheduled', 'publishing')
     and (tg_op = 'INSERT' or old.status is distinct from new.status)
     and private.publication_hold_reason(new) is not null then
    raise exception 'Lo que no está aprobado (en la versión programada) no se publica'
      using errcode = 'PB001', detail = private.publication_hold_reason(new);
  end if;
  if new.status = 'published' and (tg_op = 'INSERT' or old.status not in ('publishing', 'published')) then
    raise exception 'Solo se da por publicada una publicación que se estaba publicando' using errcode = 'PB002';
  end if;
  return new;
end $$;

-- Disparadores que reevalúan el calendario cuando cambia algo de lo que depende.
create function private.content_items_publications_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.publication_refresh(p_content_id => new.id);
  return null;
end $$;

create function private.social_accounts_publications_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.publication_refresh(p_account_id => new.id);
  return null;
end $$;

create function private.media_assets_publications_refresh() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  for v_id in
    select p.id from public.scheduled_publications p
    where p.media_asset_ids @> array[old.id] and p.status in ('planned', 'scheduled')
  loop
    perform private.publication_refresh(p_publication_id => v_id);
  end loop;
  return null;
end $$;

-- Bloquea la publicación y comprueba que quien llama edita su marca.
create function private.publication_lock_for_edit(p_publication_id uuid)
returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  select * into v_pub from public.scheduled_publications p
  where p.id = p_publication_id and p.brand_id in (select private.brand_ids_with('edit'))
  for update;
  if not found then
    raise exception 'No tienes permiso para cambiar esta publicación' using errcode = '42501';
  end if;
  return v_pub;
end $$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Pone una pieza en el calendario (p_publication_id null) o cambia una que ya
-- está (fecha, cuenta, versión y recursos). Capacidad `edit`. La base de datos
-- decide si queda armada («scheduled») o en espera («planned», con el motivo).
create function public.save_publication(
  p_publication_id uuid,
  p_content_id uuid,
  p_scheduled_at timestamptz,
  p_social_account_id uuid default null,
  p_media_asset_ids uuid[] default '{}',
  p_content_version integer default null
) returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
  v_item public.content_items;
  v_assets uuid[];
begin
  if p_publication_id is not null then
    v_pub := private.publication_lock_for_edit(p_publication_id);
    if v_pub.status not in ('planned', 'scheduled', 'failed') then
      raise exception 'Esta publicación ya no se puede cambiar' using errcode = 'P0001';
    end if;
    if p_content_id is not null and p_content_id <> v_pub.content_id then
      raise exception 'Una publicación no cambia de pieza: cancélala y programa la otra' using errcode = '22023';
    end if;
  end if;

  select * into v_item from public.content_items c
  where c.id = coalesce(v_pub.content_id, p_content_id) and c.brand_id in (select private.brand_ids_with('edit'));
  if not found then
    raise exception 'No tienes permiso para programar este contenido' using errcode = '42501';
  end if;
  if v_item.archived_at is not null then
    raise exception 'El contenido está archivado: recupéralo antes de programarlo' using errcode = 'P0001';
  end if;
  if p_scheduled_at is null then
    raise exception 'Indica cuándo se publica' using errcode = '22023';
  end if;
  if p_scheduled_at < now() - interval '1 minute' and (v_pub.id is null or p_scheduled_at <> v_pub.scheduled_at) then
    raise exception 'La fecha de publicación ya ha pasado' using errcode = '22023';
  end if;
  if p_scheduled_at > now() + interval '2 years' then
    raise exception 'Solo se programa hasta dos años vista' using errcode = '22023';
  end if;
  if p_social_account_id is not null and not exists (
    select 1 from public.social_accounts a
    where a.id = p_social_account_id and a.brand_id = v_item.brand_id and a.network = v_item.network
      and a.status <> 'disconnected'
  ) then
    raise exception 'Esa cuenta no es de esta marca o no es de la red del contenido' using errcode = '22023';
  end if;
  -- Sin repetidos, en el orden dado, y todos de la marca.
  select coalesce(array_agg(x.id order by x.ord), '{}') into v_assets
  from (select distinct on (u.id) u.id, u.ord from unnest(coalesce(p_media_asset_ids, '{}')) with ordinality u(id, ord)
        order by u.id, u.ord) x;
  if cardinality(v_assets) > 20 then
    raise exception 'Demasiados recursos para una publicación' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_assets) u(id)
             where not exists (select 1 from public.media_assets a where a.id = u.id and a.brand_id = v_item.brand_id)) then
    raise exception 'Los recursos tienen que ser de la biblioteca de esta marca' using errcode = '22023';
  end if;
  if p_content_version is not null and not exists (
    select 1 from public.content_versions v where v.content_id = v_item.id and v.version = p_content_version
  ) then
    raise exception 'Esa versión no existe' using errcode = 'P0001';
  end if;

  if v_pub.id is null then
    insert into public.scheduled_publications (brand_id, organization_id, content_id, content_version,
                                               social_account_id, network, format, scheduled_at, media_asset_ids,
                                               status, hold_reason)
    values (v_item.brand_id, v_item.organization_id, v_item.id, p_content_version, p_social_account_id,
            v_item.network, v_item.format, p_scheduled_at, v_assets, 'planned', 'not_approved')
    returning * into v_pub;
  else
    update public.scheduled_publications p
    set scheduled_at = p_scheduled_at, social_account_id = p_social_account_id, media_asset_ids = v_assets,
        content_version = p_content_version,
        status = case when p.status = 'failed' then p.status else 'planned' end,
        hold_reason = case when p.status = 'failed' then null else 'not_approved' end
    where p.id = v_pub.id
    returning * into v_pub;
  end if;

  perform private.publication_refresh(p_publication_id => v_pub.id);
  select * into v_pub from public.scheduled_publications p where p.id = v_pub.id;
  return v_pub;
end $$;

-- Cambia solo la fecha (arrastrar y soltar en el calendario).
create function public.reschedule_publication(p_publication_id uuid, p_scheduled_at timestamptz)
returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  v_pub := private.publication_lock_for_edit(p_publication_id);
  if v_pub.status not in ('planned', 'scheduled', 'failed') then
    raise exception 'Esta publicación ya no se puede mover' using errcode = 'P0001';
  end if;
  if p_scheduled_at is null or p_scheduled_at < now() - interval '1 minute' then
    raise exception 'La fecha de publicación ya ha pasado' using errcode = '22023';
  end if;
  if p_scheduled_at > now() + interval '2 years' then
    raise exception 'Solo se programa hasta dos años vista' using errcode = '22023';
  end if;
  update public.scheduled_publications p set scheduled_at = p_scheduled_at where p.id = v_pub.id
  returning * into v_pub;
  return v_pub;
end $$;

-- Cancela una publicación que todavía no ha salido.
create function public.cancel_publication(p_publication_id uuid)
returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  v_pub := private.publication_lock_for_edit(p_publication_id);
  if v_pub.status not in ('planned', 'scheduled', 'failed') then
    raise exception 'Esta publicación ya no se puede cancelar' using errcode = 'P0001';
  end if;
  update public.scheduled_publications p
  set status = 'cancelled', hold_reason = null
  where p.id = v_pub.id
  returning * into v_pub;
  return v_pub;
end $$;

-- Reintenta una publicación fallida: vuelve al calendario (armada si cumple la
-- regla) con una generación nueva para la cola. El contenedor que ya se creó
-- se conserva: el publicador lo mira antes de crear otro o de publicar.
create function public.retry_publication(p_publication_id uuid)
returns public.scheduled_publications
language plpgsql security definer set search_path = '' as $$
declare
  v_pub public.scheduled_publications;
begin
  v_pub := private.publication_lock_for_edit(p_publication_id);
  if v_pub.status <> 'failed' then
    raise exception 'Solo se reintenta una publicación que ha fallado' using errcode = 'P0001';
  end if;
  update public.scheduled_publications p
  set status = 'planned', hold_reason = 'not_approved', generation = p.generation + 1,
      scheduled_at = greatest(p.scheduled_at, now())
  where p.id = v_pub.id;
  perform private.publication_refresh(p_publication_id => v_pub.id);
  select * into v_pub from public.scheduled_publications p where p.id = v_pub.id;
  return v_pub;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger scheduled_publications_touch before update on public.scheduled_publications
  for each row execute function private.touch_updated_at();
create trigger scheduled_publications_guard before insert or update on public.scheduled_publications
  for each row execute function private.scheduled_publications_guard();

create trigger content_items_publications_refresh
  after update of status, current_version, archived_at, network, format on public.content_items
  for each row execute function private.content_items_publications_refresh();
create trigger social_accounts_publications_refresh after update of status on public.social_accounts
  for each row execute function private.social_accounts_publications_refresh();
create trigger media_assets_publications_refresh after delete on public.media_assets
  for each row execute function private.media_assets_publications_refresh();

-- Auditoría: alta, cambios de estado, de fecha y de cuenta, y borrado. Los
-- intentos son su propio registro.
create trigger scheduled_publications_audit
  after insert or update of status, scheduled_at, social_account_id or delete on public.scheduled_publications
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.scheduled_publications enable row level security;
alter table public.publication_attempts enable row level security;

-- Ve el calendario y los intentos quien ve la marca. Sin políticas de escritura.
create policy scheduled_publications_select on public.scheduled_publications for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy publication_attempts_select on public.publication_attempts for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.scheduled_publications, public.publication_attempts to authenticated, service_role;

revoke all on function private.publication_format_supported(text, text) from public, anon, authenticated;
revoke all on function private.publication_media_problem(uuid, uuid, integer, text, uuid[]) from public, anon, authenticated;
revoke all on function private.publication_hold_reason(public.scheduled_publications) from public, anon, authenticated;
revoke all on function private.publication_refresh(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function private.scheduled_publications_guard() from public, anon, authenticated;
revoke all on function private.content_items_publications_refresh() from public, anon, authenticated;
revoke all on function private.social_accounts_publications_refresh() from public, anon, authenticated;
revoke all on function private.media_assets_publications_refresh() from public, anon, authenticated;
revoke all on function private.publication_lock_for_edit(uuid) from public, anon, authenticated;

revoke all on function public.save_publication(uuid, uuid, timestamptz, uuid, uuid[], integer) from public, anon, authenticated;
revoke all on function public.reschedule_publication(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_publication(uuid) from public, anon, authenticated;
revoke all on function public.retry_publication(uuid) from public, anon, authenticated;

grant execute on function public.save_publication(uuid, uuid, timestamptz, uuid, uuid[], integer) to authenticated;
grant execute on function public.reschedule_publication(uuid, timestamptz) to authenticated;
grant execute on function public.cancel_publication(uuid) to authenticated;
grant execute on function public.retry_publication(uuid) to authenticated;
