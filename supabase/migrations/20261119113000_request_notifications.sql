-- Encargos: avisos dentro de la aplicación.
--
-- No hay correo (falta un SMTP propio), así que los avisos viven en la base
-- de datos y la aplicación los enseña como insignia en el menú «Encargos»:
--
--   * `request_created`: al pedirse un encargo, para cada persona que puede
--     prepararlo (capacidad `edit` sobre la marca: propietarios y
--     administradores de la organización, gestores y editores de la marca),
--     salvo quien lo pide.
--   * `request_delivered`: al entregarse, para quien lo pidió (salvo que lo
--     entregue él mismo).
--
-- Los escribe un disparador sobre `content_requests`; nadie los inserta a
-- mano. Cada persona lee solo los suyos, y solo de las marcas que sigue
-- viendo (si pierde el acceso, deja de verlos). Marcar como leído pasa por
-- `mark_request_notifications_read`, que solo toca los propios.

create table public.request_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  request_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  kind text not null check (kind in ('request_created', 'request_delivered')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (request_id, brand_id, organization_id)
    references public.content_requests (id, brand_id, organization_id) on delete cascade
);
create index request_notifications_user_unread_idx on public.request_notifications (user_id, brand_id)
  where read_at is null;
create index request_notifications_request_idx on public.request_notifications (request_id);

-- Personas que pueden preparar encargos de una marca (capacidad `edit`), con
-- la misma regla que private.brand_ids_with.
create function private.brand_editor_ids(p_brand_id uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct om.user_id
  from public.brands b
  join public.organization_members om on om.organization_id = b.organization_id
  left join public.brand_members bm on bm.brand_id = b.id and bm.user_id = om.user_id
  where b.id = p_brand_id
    and ((om.role in ('owner', 'admin') and private.brand_role_grants('manager', 'edit'))
         or (bm.role is not null and private.brand_role_grants(bm.role, 'edit')));
$$;

create function private.content_requests_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    insert into public.request_notifications (user_id, request_id, brand_id, organization_id, kind)
    select e.id, new.id, new.brand_id, new.organization_id, 'request_created'
    from private.brand_editor_ids(new.brand_id) e(id)
    where e.id is distinct from v_actor and e.id is distinct from new.requested_by;
  elsif new.status = 'delivered' and old.status is distinct from 'delivered'
        and new.requested_by is not null and new.requested_by is distinct from v_actor then
    insert into public.request_notifications (user_id, request_id, brand_id, organization_id, kind)
    values (new.requested_by, new.id, new.brand_id, new.organization_id, 'request_delivered');
  end if;
  -- Un encargo cerrado ya no necesita aviso: lo pendiente se da por leído.
  if tg_op = 'UPDATE' and new.status in ('accepted', 'cancelled') and old.status is distinct from new.status then
    update public.request_notifications n set read_at = now()
    where n.request_id = new.id and n.read_at is null;
  end if;
  return null;
end $$;

create trigger content_requests_notify after insert or update of status on public.content_requests
  for each row execute function private.content_requests_notify();

-- Marca como leídos los avisos propios: los indicados, los de un encargo o,
-- sin nada, todos los de la marca. Devuelve cuántos ha marcado.
create function public.mark_request_notifications_read(
  p_brand_id uuid,
  p_request_id uuid default null
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Inicia sesión' using errcode = '42501';
  end if;
  update public.request_notifications n
  set read_at = now()
  where n.user_id = (select auth.uid())
    and n.brand_id = p_brand_id
    and (p_request_id is null or n.request_id = p_request_id)
    and n.read_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

alter table public.request_notifications enable row level security;

create policy request_notifications_select on public.request_notifications for select to authenticated
  using (user_id = (select auth.uid()) and brand_id in (select private.brand_ids_with('view')));

revoke all on public.request_notifications from anon, authenticated, public;
grant select on public.request_notifications to authenticated;
grant all on public.request_notifications to service_role;

revoke all on function private.brand_editor_ids(uuid) from public, anon, authenticated;
revoke all on function private.content_requests_notify() from public, anon, authenticated;
revoke all on function public.mark_request_notifications_read(uuid, uuid) from public, anon, authenticated;
grant execute on function public.mark_request_notifications_read(uuid, uuid) to authenticated;
