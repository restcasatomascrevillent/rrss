-- Fase 3 · Comentarios y aprobaciones de una pieza (docs/publicacion.md).
--
--   * `content_comments` es la conversación de una pieza: comentarios de
--     personas y los hechos de su aprobación (aprobada en la versión N, pedidos
--     cambios, aprobación retirada al guardar otra versión). Los encargos ya
--     tienen su propia conversación (`content_request_comments`) y se quedan
--     como están: esta es la de la pieza, exista o no un encargo.
--   * Los hechos de aprobación los escribe un disparador sobre `content_items`,
--     así quedan registrados vengan de donde vengan (editor, calendario, aceptar
--     un encargo).
--   * Aprobar por lotes (`approve_content_items`) aplica a cada pieza las mismas
--     reglas que `set_content_status`: capacidad `approve`, pieza en revisión y
--     versión indicada. Si una falla, las demás siguen y se dice por qué.

create table public.content_comments (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  -- Versión a la que se refiere (null = a la pieza en general).
  version integer check (version is null or version > 0),
  -- comment: lo escribe una persona · approved / unapproved / changes_requested: hechos de la aprobación.
  kind text not null check (kind in ('comment', 'approved', 'unapproved', 'changes_requested')),
  body text not null default '' check (char_length(body) <= 5000),
  author_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (content_id, brand_id, organization_id)
    references public.content_items (id, brand_id, organization_id) on delete cascade,
  check (kind not in ('comment', 'changes_requested') or char_length(btrim(body)) > 0)
);
create index content_comments_content_idx on public.content_comments (content_id, created_at);
create index content_comments_brand_idx on public.content_comments (brand_id);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Apunta en la conversación de la pieza que se aprobó o que la aprobación se
-- retiró porque se guardó otra versión.
create function private.content_items_approval_log() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'approved' and old.status <> 'approved' then
    insert into public.content_comments (content_id, brand_id, organization_id, version, kind, author_id)
    values (new.id, new.brand_id, new.organization_id, new.current_version, 'approved', (select auth.uid()));
  elsif old.status = 'approved' and new.status <> 'approved' and new.current_version <> old.current_version then
    insert into public.content_comments (content_id, brand_id, organization_id, version, kind, body, author_id)
    values (new.id, new.brand_id, new.organization_id, new.current_version, 'unapproved',
            'Se guardó la versión ' || new.current_version || ': hay que volver a aprobarla.', (select auth.uid()));
  end if;
  return null;
end $$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Comenta una pieza (capacidad `comment`).
create function public.comment_content_item(p_content_id uuid, p_body text, p_version integer default null)
returns public.content_comments
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.content_items;
  v_comment public.content_comments;
begin
  select * into v_item from public.content_items c
  where c.id = p_content_id and c.brand_id in (select private.brand_ids_with('comment'));
  if not found then
    raise exception 'No tienes permiso para comentar este contenido' using errcode = '42501';
  end if;
  if p_body is null or btrim(p_body) = '' then
    raise exception 'Escribe el comentario' using errcode = '22023';
  end if;
  if p_version is not null and not exists (
    select 1 from public.content_versions v where v.content_id = v_item.id and v.version = p_version
  ) then
    raise exception 'Esa versión no existe' using errcode = 'P0001';
  end if;
  insert into public.content_comments (content_id, brand_id, organization_id, version, kind, body, author_id)
  values (v_item.id, v_item.brand_id, v_item.organization_id, p_version, 'comment', left(btrim(p_body), 5000),
          (select auth.uid()))
  returning * into v_comment;
  return v_comment;
end $$;

-- Devuelve a borrador lo que está en revisión o aprobado, con el motivo
-- (capacidad `approve`; las reglas de set_content_status).
create function public.request_content_changes(p_content_id uuid, p_message text)
returns public.content_items
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.content_items;
begin
  if p_message is null or btrim(p_message) = '' then
    raise exception 'Explica qué hay que cambiar' using errcode = '22023';
  end if;
  if p_content_id is null or not exists (
    select 1 from public.content_items c
    where c.id = p_content_id and c.brand_id in (select private.brand_ids_with('approve'))
  ) then
    raise exception 'No tienes permiso para pedir cambios en este contenido' using errcode = '42501';
  end if;
  v_item := public.set_content_status(p_content_id, 'draft');
  insert into public.content_comments (content_id, brand_id, organization_id, version, kind, body, author_id)
  values (v_item.id, v_item.brand_id, v_item.organization_id, nullif(v_item.current_version, 0), 'changes_requested',
          left(btrim(p_message), 5000), (select auth.uid()));
  return v_item;
end $$;

-- Aprueba varias piezas, cada una en la versión indicada:
--   p_items = [{"content_id": "<uuid>", "version": 3}, …]  (como mucho 100)
-- Devuelve una fila por pieza: si se aprobó y, si no, por qué.
create function public.approve_content_items(p_items jsonb)
returns table (content_id uuid, ok boolean, message text)
language plpgsql security definer set search_path = '' as $$
declare
  v_item jsonb;
  v_id uuid;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Indica qué contenidos apruebas' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Se pueden aprobar como mucho 100 contenidos a la vez' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_id := null;
    begin
      v_id := (v_item ->> 'content_id')::uuid;
      if v_id is null or (v_item ->> 'version') is null then
        raise exception 'Indica el contenido y la versión que apruebas' using errcode = '22023';
      end if;
      perform public.set_content_status(v_id, 'approved', (v_item ->> 'version')::integer);
      content_id := v_id;
      ok := true;
      message := null;
    exception when others then
      content_id := v_id;
      ok := false;
      message := sqlerrm;
    end;
    return next;
  end loop;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger content_items_approval_log after update of status on public.content_items
  for each row execute function private.content_items_approval_log();

create trigger content_comments_audit after insert on public.content_comments
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.content_comments enable row level security;

create policy content_comments_select on public.content_comments for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.content_comments to authenticated, service_role;

revoke all on function private.content_items_approval_log() from public, anon, authenticated;
revoke all on function public.comment_content_item(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.request_content_changes(uuid, text) from public, anon, authenticated;
revoke all on function public.approve_content_items(jsonb) from public, anon, authenticated;

grant execute on function public.comment_content_item(uuid, text, integer) to authenticated;
grant execute on function public.request_content_changes(uuid, text) to authenticated;
grant execute on function public.approve_content_items(jsonb) to authenticated;
