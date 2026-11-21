-- Modo agencia · Encargos: el cliente pide una pieza, quien edita la marca (por
-- ejemplo, la agencia que la gestiona) la toma y entrega un borrador, y quien
-- puede aprobar la acepta o pide cambios (docs/02-modelo-de-datos.md, «Encargos»).
--
--   * `content_requests` es el encargo: de una marca, con red y formato del
--     catálogo de la aplicación, tipo de medio, texto del encargo, recursos de
--     la biblioteca de referencia y fecha deseada. Lleva enlazada la pieza
--     (`content_items`) que se entrega y la versión entregada.
--   * `content_request_comments` es la conversación y el historial: cada
--     comentario y cada cambio de estado es una fila con su autor y su fecha.
--   * Estados: requested → in_progress → delivered → (changes_requested →
--     in_progress → delivered)… → accepted, o cancelled.
--   * Nadie escribe estas tablas a mano: todo pasa por las funciones de abajo,
--     que comprueban la capacidad sobre la marca (private.brand_ids_with).
--       pedir y comentar ......... comment  (gestor, editor, revisor, cliente)
--       tomar, soltar, entregar .. edit     (gestor, editor)
--       aceptar, pedir cambios ... approve  (gestor, revisor, cliente)
--       cancelar ................. quien lo pidió, o manage (gestor)
--   * Tomar un encargo es un cerrojo con caducidad: quien lo toma puede indicar
--     una clave de sesión, y mientras no caduque nadie más (ni otra sesión de la
--     misma cuenta) lo puede tomar ni entregar (RQ001).
--   * Entregar crea la pieza (o añade una versión a la ya enlazada) y la deja en
--     borrador, todo en una transacción.
--   * Aceptar aprueba la pieza en la versión entregada: si la pieza ha cambiado
--     desde la entrega, falla (RQ002) en vez de aprobar algo que nadie revisó.
--
-- Además, `brands.ai_mode` dice cómo se redacta con IA en la marca: `api`
-- (el servicio de IA de la plataforma) o `agency` (se pide a la agencia).

-- ───────────────────────────── Tipos ─────────────────────────────

create type public.content_request_status as enum (
  'requested', 'in_progress', 'delivered', 'changes_requested', 'accepted', 'cancelled'
);

-- ───────────────────────── Modo de IA de la marca ─────────────────────────

alter table public.brands
  add column ai_mode text not null default 'api' check (ai_mode in ('api', 'agency'));

-- Lo cambia quien gestiona la marca (política brands_update: manage).
grant update (ai_mode) on public.brands to authenticated;

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.content_requests (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Resumen del encargo, para las listas.
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- El encargo en palabras del cliente. Es dato, nunca instrucciones.
  brief text not null check (char_length(btrim(brief)) between 1 and 5000),
  -- Destino, del catálogo de la aplicación (src/features/content/networks.ts).
  network text not null check (network ~ '^[a-z][a-z0-9_]{0,31}$'),
  format text not null check (format ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Tipo de pieza: imagen o vídeo. Null = lo decide quien la prepara.
  media_kind text check (media_kind in ('image', 'video')),
  -- Recursos de la biblioteca de referencia (de esta misma marca al pedirlo).
  reference_asset_ids uuid[] not null default '{}' check (cardinality(reference_asset_ids) <= 20),
  desired_date date,
  status public.content_request_status not null default 'requested',
  -- Pieza entregada (o la pieza sobre la que se pidió el encargo).
  content_id uuid,
  delivered_version integer check (delivered_version is null or delivered_version > 0),
  requested_by uuid references auth.users (id) on delete set null,
  -- Cerrojo: quién lo tiene, con qué clave de sesión y hasta cuándo.
  claimed_by uuid references auth.users (id) on delete set null,
  claim_token text check (claim_token is null or char_length(claim_token) between 8 and 100),
  claimed_until timestamptz,
  delivered_by uuid references auth.users (id) on delete set null,
  delivered_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  -- La pieza es de la misma marca y organización que el encargo.
  foreign key (content_id, brand_id, organization_id)
    references public.content_items (id, brand_id, organization_id) on delete cascade,
  unique (id, brand_id, organization_id),
  check (status not in ('delivered', 'accepted') or (content_id is not null and delivered_version is not null))
);
create index content_requests_brand_created_idx on public.content_requests (brand_id, created_at desc);
create index content_requests_status_idx on public.content_requests (brand_id, status);
-- Una pieza tiene como mucho un encargo abierto.
create unique index content_requests_open_content_idx on public.content_requests (content_id)
  where content_id is not null and status not in ('accepted', 'cancelled');

create table public.content_request_comments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  -- comment: lo escribe una persona · status: cambio de estado (con nota opcional).
  kind text not null check (kind in ('comment', 'status')),
  status public.content_request_status,
  body text not null default '' check (char_length(body) <= 5000),
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (request_id, brand_id, organization_id)
    references public.content_requests (id, brand_id, organization_id) on delete cascade,
  check ((kind = 'status') = (status is not null)),
  check (kind = 'status' or char_length(btrim(body)) > 0)
);
create index content_request_comments_request_idx on public.content_request_comments (request_id, created_at);
create index content_request_comments_brand_idx on public.content_request_comments (brand_id);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Apunta un comentario o un cambio de estado en la conversación del encargo.
create function private.content_request_log(
  p_request public.content_requests,
  p_kind text,
  p_status public.content_request_status,
  p_body text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.content_request_comments (request_id, brand_id, organization_id, kind, status, body, author_id)
  values (p_request.id, p_request.brand_id, p_request.organization_id, p_kind, p_status,
          left(coalesce(btrim(p_body), ''), 5000), (select auth.uid()));
end $$;

-- Bloquea el encargo y comprueba que el usuario tiene la capacidad sobre su
-- marca. Sin permiso (o si no existe) falla con 42501 sin decir cuál de las dos.
create function private.content_request_lock(p_request_id uuid, p_capability text, p_message text)
returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
begin
  select * into v_request from public.content_requests r
  where r.id = p_request_id and r.brand_id in (select private.brand_ids_with(p_capability))
  for update;
  if not found then
    raise exception '%', p_message using errcode = '42501';
  end if;
  return v_request;
end $$;

-- ¿Tiene otra persona u otra sesión el encargo tomado, y sin caducar?
create function private.content_request_claimed_by_other(p_request public.content_requests, p_claim_token text)
returns boolean
language sql stable set search_path = '' as $$
  select p_request.status = 'in_progress'
     and p_request.claimed_until is not null and p_request.claimed_until > now()
     and (p_request.claimed_by is distinct from (select auth.uid())
          or p_request.claim_token is distinct from nullif(btrim(coalesce(p_claim_token, '')), ''));
$$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Pide un encargo. Lo puede pedir quien puede comentar en la marca (también el
-- cliente). Con p_content_id, el encargo es sobre una pieza que ya existe.
create function public.create_content_request(
  p_brand_id uuid,
  p_title text,
  p_brief text,
  p_network text,
  p_format text,
  p_media_kind text default null,
  p_reference_asset_ids uuid[] default '{}',
  p_desired_date date default null,
  p_content_id uuid default null
) returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_brand public.brands;
  v_request public.content_requests;
  v_assets uuid[] := coalesce(p_reference_asset_ids, '{}');
  v_item public.content_items;
begin
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.id in (select private.brand_ids_with('comment'));
  if not found then
    raise exception 'No tienes permiso para pedir encargos en esta marca' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_title, ''))) = 0 or char_length(btrim(coalesce(p_brief, ''))) = 0 then
    raise exception 'El encargo necesita un título y una descripción' using errcode = '22023';
  end if;
  v_assets := array(select distinct unnest(v_assets));
  if cardinality(v_assets) > 20 then
    raise exception 'Como mucho 20 recursos de referencia' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_assets) a(id)
    where not exists (select 1 from public.media_assets m where m.id = a.id and m.brand_id = v_brand.id)
  ) then
    raise exception 'Algún recurso de referencia no es de esta marca' using errcode = '22023';
  end if;
  if p_content_id is not null then
    select * into v_item from public.content_items c where c.id = p_content_id and c.brand_id = v_brand.id;
    if not found then
      raise exception 'Esa pieza no es de esta marca' using errcode = '22023';
    end if;
    if v_item.archived_at is not null then
      raise exception 'El contenido está archivado: recupéralo antes de pedir un encargo' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.content_requests r
      where r.content_id = v_item.id and r.status not in ('accepted', 'cancelled')
    ) then
      raise exception 'Esta pieza ya tiene un encargo abierto' using errcode = 'P0001';
    end if;
  end if;

  insert into public.content_requests (brand_id, organization_id, title, brief, network, format, media_kind,
                                       reference_asset_ids, desired_date, content_id, requested_by)
  values (v_brand.id, v_brand.organization_id, btrim(p_title), btrim(p_brief),
          coalesce(v_item.network, p_network), coalesce(v_item.format, p_format), p_media_kind,
          v_assets, p_desired_date, v_item.id, (select auth.uid()))
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'requested', '');
  return v_request;
end $$;

-- Comenta un encargo. Quien puede comentar en la marca (también el cliente).
create function public.comment_content_request(p_request_id uuid, p_body text)
returns public.content_request_comments
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_comment public.content_request_comments;
begin
  select * into v_request from public.content_requests r
  where r.id = p_request_id and r.brand_id in (select private.brand_ids_with('comment'));
  if not found then
    raise exception 'No tienes permiso para comentar este encargo' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_body, ''))) = 0 then
    raise exception 'Escribe el comentario' using errcode = '22023';
  end if;
  if char_length(btrim(p_body)) > 5000 then
    raise exception 'El comentario es demasiado largo' using errcode = '22023';
  end if;
  insert into public.content_request_comments (request_id, brand_id, organization_id, kind, body, author_id)
  values (v_request.id, v_request.brand_id, v_request.organization_id, 'comment', btrim(p_body), (select auth.uid()))
  returning * into v_comment;
  return v_comment;
end $$;

-- Encargos que el usuario puede preparar: de las marcas que edita, pedidos o
-- con cambios pedidos, y los que están en curso con el cerrojo caducado o suyo.
create function public.pending_content_requests()
returns setof public.content_requests
language sql stable security definer set search_path = '' as $$
  select r.* from public.content_requests r
  where r.brand_id in (select private.brand_ids_with('edit'))
    and (r.status in ('requested', 'changes_requested')
         or (r.status = 'in_progress'
             and (r.claimed_until is null or r.claimed_until <= now() or r.claimed_by = (select auth.uid()))))
  order by r.desired_date nulls last, r.created_at
  limit 200;
$$;

-- Toma un encargo (cerrojo). Con la misma clave de sesión renueva el cerrojo;
-- si lo tiene otra persona u otra sesión y no ha caducado, falla con RQ001.
create function public.take_content_request(
  p_request_id uuid,
  p_claim_token text default null,
  p_lease_minutes integer default 240
) returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_token text := nullif(btrim(coalesce(p_claim_token, '')), '');
  v_renewal boolean;
begin
  v_request := private.content_request_lock(p_request_id, 'edit', 'No tienes permiso para preparar este encargo');
  if p_lease_minutes is null or p_lease_minutes < 5 or p_lease_minutes > 1440 then
    raise exception 'El cerrojo dura entre 5 minutos y 24 horas' using errcode = '22023';
  end if;
  if v_token is not null and char_length(v_token) not between 8 and 100 then
    raise exception 'La clave de sesión debe tener entre 8 y 100 caracteres' using errcode = '22023';
  end if;
  if v_request.status not in ('requested', 'changes_requested', 'in_progress') then
    raise exception 'Este encargo no se puede tomar en su estado actual' using errcode = 'P0001';
  end if;
  if private.content_request_claimed_by_other(v_request, v_token) then
    raise exception 'Este encargo ya lo está preparando otra persona u otra sesión' using errcode = 'RQ001',
      detail = jsonb_build_object('claimed_until', v_request.claimed_until)::text;
  end if;

  v_renewal := v_request.status = 'in_progress';
  update public.content_requests r
  set status = 'in_progress', claimed_by = (select auth.uid()), claim_token = v_token,
      claimed_until = now() + make_interval(mins => p_lease_minutes)
  where r.id = v_request.id
  returning * into v_request;
  if not v_renewal then
    perform private.content_request_log(v_request, 'status', 'in_progress', '');
  end if;
  return v_request;
end $$;

-- Suelta un encargo tomado: vuelve a «pedido» o a «cambios pedidos».
create function public.release_content_request(p_request_id uuid, p_claim_token text default null)
returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_status public.content_request_status;
begin
  v_request := private.content_request_lock(p_request_id, 'edit', 'No tienes permiso para preparar este encargo');
  if v_request.status <> 'in_progress' then
    raise exception 'Este encargo no está en curso' using errcode = 'P0001';
  end if;
  if private.content_request_claimed_by_other(v_request, p_claim_token) then
    raise exception 'Este encargo lo tiene otra persona u otra sesión' using errcode = 'RQ001';
  end if;
  v_status := case when v_request.delivered_version is null then 'requested' else 'changes_requested' end;
  update public.content_requests r
  set status = v_status, claimed_by = null, claim_token = null, claimed_until = null
  where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', v_status, 'Encargo soltado sin entregar');
  return v_request;
end $$;

-- Entrega un encargo tomado: guarda el documento como versión nueva de la pieza
-- enlazada (o crea la pieza si no hay ninguna), la deja en borrador, la enlaza
-- y marca el encargo como entregado. Todo o nada.
--   42501  sin permiso de edición · RQ001  lo tiene otra sesión · P0001  estado
create function public.deliver_content_request(
  p_request_id uuid,
  p_data jsonb,
  p_schema_version integer,
  p_claim_token text default null,
  p_title text default null,
  p_change_note text default null
) returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_content_id uuid;
  v_version public.content_versions;
  v_note text := coalesce(nullif(btrim(coalesce(p_change_note, '')), ''), 'Entregado por la agencia');
begin
  v_request := private.content_request_lock(p_request_id, 'edit', 'No tienes permiso para entregar este encargo');
  if v_request.status <> 'in_progress' then
    raise exception 'Solo se entrega un encargo en curso: tómalo antes' using errcode = 'P0001';
  end if;
  if private.content_request_claimed_by_other(v_request, p_claim_token) then
    raise exception 'Este encargo lo tiene otra persona u otra sesión' using errcode = 'RQ001';
  end if;

  v_content_id := v_request.content_id;
  if v_content_id is null then
    insert into public.content_items (brand_id, organization_id, title, network, format, created_by)
    values (v_request.brand_id, v_request.organization_id,
            left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_request.title), 200),
            v_request.network, v_request.format, (select auth.uid()))
    returning id into v_content_id;
  end if;

  -- Comprueba otra vez el permiso de edición, bloquea la pieza y numera la versión.
  v_version := private.content_write_version(v_content_id, p_data, p_schema_version, v_note, null, null);
  -- Lo entregado es un borrador, aunque la pieza estuviera en revisión.
  update public.content_items c set status = 'draft' where c.id = v_content_id and c.status <> 'draft';

  update public.content_requests r
  set status = 'delivered', content_id = v_content_id, delivered_version = v_version.version,
      delivered_by = (select auth.uid()), delivered_at = now(),
      claimed_by = null, claim_token = null, claimed_until = null
  where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'delivered', v_note);
  return v_request;
end $$;

-- Pide cambios sobre lo entregado. Quien puede aprobar; el mensaje es obligatorio.
create function public.request_content_request_changes(p_request_id uuid, p_message text)
returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
begin
  v_request := private.content_request_lock(p_request_id, 'approve', 'No tienes permiso para revisar este encargo');
  if v_request.status <> 'delivered' then
    raise exception 'Solo se piden cambios sobre un encargo entregado' using errcode = 'P0001';
  end if;
  if char_length(btrim(coalesce(p_message, ''))) = 0 then
    raise exception 'Explica qué cambios necesitas' using errcode = '22023';
  end if;
  update public.content_requests r set status = 'changes_requested' where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'changes_requested', p_message);
  return v_request;
end $$;

-- Acepta lo entregado y aprueba la pieza en la versión entregada. Si la pieza
-- tiene una versión posterior a la entregada, falla (RQ002): lo que se aprobaría
-- no es lo que se revisó.
create function public.accept_content_request(p_request_id uuid)
returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_item public.content_items;
begin
  v_request := private.content_request_lock(p_request_id, 'approve', 'No tienes permiso para aceptar este encargo');
  if v_request.status <> 'delivered' then
    raise exception 'Solo se acepta un encargo entregado' using errcode = 'P0001';
  end if;
  select * into v_item from public.content_items c where c.id = v_request.content_id for update;
  if not found then
    raise exception 'La pieza entregada ya no existe' using errcode = 'P0001';
  end if;
  if v_item.archived_at is not null then
    raise exception 'La pieza entregada está archivada' using errcode = 'P0001';
  end if;
  if v_item.current_version <> v_request.delivered_version then
    raise exception 'La pieza ha cambiado desde la entrega: revisa la versión vigente antes de aceptar'
      using errcode = 'RQ002',
            detail = jsonb_build_object(
              'current_version', v_item.current_version, 'delivered_version', v_request.delivered_version)::text;
  end if;
  if v_item.status <> 'approved' then
    update public.content_items c set status = 'approved' where c.id = v_item.id;
  end if;
  update public.content_requests r
  set status = 'accepted', accepted_by = (select auth.uid()), accepted_at = now()
  where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'accepted', '');
  return v_request;
end $$;

-- Cancela un encargo que no está cerrado. Quien lo pidió (si sigue pudiendo
-- comentar en la marca) o quien gestiona la marca.
create function public.cancel_content_request(p_request_id uuid, p_reason text default '')
returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
begin
  select * into v_request from public.content_requests r
  where r.id = p_request_id
    and (r.brand_id in (select private.brand_ids_with('manage'))
         or (r.requested_by = (select auth.uid()) and r.brand_id in (select private.brand_ids_with('comment'))))
  for update;
  if not found then
    raise exception 'No tienes permiso para cancelar este encargo' using errcode = '42501';
  end if;
  if v_request.status in ('accepted', 'cancelled') then
    raise exception 'Este encargo ya está cerrado' using errcode = 'P0001';
  end if;
  update public.content_requests r
  set status = 'cancelled', claimed_by = null, claim_token = null, claimed_until = null
  where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'cancelled', p_reason);
  return v_request;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger content_requests_touch before update on public.content_requests
  for each row execute function private.touch_updated_at();

-- Auditoría como el resto: alta, cambios de estado y de pieza, y borrado del
-- encargo; alta de cada comentario.
create trigger content_requests_audit
  after insert or update of status, content_id or delete on public.content_requests
  for each row execute function private.audit();
create trigger content_request_comments_audit after insert on public.content_request_comments
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.content_requests enable row level security;
alter table public.content_request_comments enable row level security;

-- Ve los encargos y su conversación quien ve la marca. No hay políticas de
-- escritura: se escribe solo con las funciones de arriba.
create policy content_requests_select on public.content_requests for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy content_request_comments_select on public.content_request_comments for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.content_requests, public.content_request_comments to authenticated, service_role;

revoke all on function private.content_request_log(public.content_requests, text, public.content_request_status, text)
  from public, anon, authenticated;
revoke all on function private.content_request_lock(uuid, text, text) from public, anon, authenticated;
revoke all on function private.content_request_claimed_by_other(public.content_requests, text)
  from public, anon, authenticated;

revoke all on function public.create_content_request(uuid, text, text, text, text, text, uuid[], date, uuid)
  from public, anon, authenticated;
revoke all on function public.comment_content_request(uuid, text) from public, anon, authenticated;
revoke all on function public.pending_content_requests() from public, anon, authenticated;
revoke all on function public.take_content_request(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_content_request(uuid, text) from public, anon, authenticated;
revoke all on function public.deliver_content_request(uuid, jsonb, integer, text, text, text)
  from public, anon, authenticated;
revoke all on function public.request_content_request_changes(uuid, text) from public, anon, authenticated;
revoke all on function public.accept_content_request(uuid) from public, anon, authenticated;
revoke all on function public.cancel_content_request(uuid, text) from public, anon, authenticated;

grant execute on function public.create_content_request(uuid, text, text, text, text, text, uuid[], date, uuid)
  to authenticated;
grant execute on function public.comment_content_request(uuid, text) to authenticated;
grant execute on function public.pending_content_requests() to authenticated;
grant execute on function public.take_content_request(uuid, text, integer) to authenticated;
grant execute on function public.release_content_request(uuid, text) to authenticated;
grant execute on function public.deliver_content_request(uuid, jsonb, integer, text, text, text) to authenticated;
grant execute on function public.request_content_request_changes(uuid, text) to authenticated;
grant execute on function public.accept_content_request(uuid) to authenticated;
grant execute on function public.cancel_content_request(uuid, text) to authenticated;
