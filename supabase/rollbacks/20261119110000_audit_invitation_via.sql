-- Vuelta atrás de 20261119110000_audit_invitation_via.sql: vuelven las
-- versiones originales de private.audit y accept_invitation. Las filas ya
-- registradas conservan `data.via` (la interfaz lo entiende igual).

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_org uuid;
  v_brand uuid;
begin
  if tg_op = 'DELETE' then
    v_row := to_jsonb(old);
  else
    v_row := to_jsonb(new);
  end if;

  if tg_table_name = 'organizations' then
    v_org := (v_row ->> 'id')::uuid;
  else
    v_org := (v_row ->> 'organization_id')::uuid;
  end if;
  if tg_table_name = 'brands' then
    v_brand := (v_row ->> 'id')::uuid;
  else
    v_brand := (v_row ->> 'brand_id')::uuid;
  end if;

  insert into public.audit_logs (organization_id, brand_id, actor_id, action, entity_type, entity_id, data)
  values (
    v_org,
    v_brand,
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id'),
    v_row - 'data' - 'provenance' - 'token_hash' - 'settings'
  );
  return null;
end $$;

create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
  v_inv public.invitations;
  v_current public.org_role;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;

  select * into v_inv from public.invitations i
  where i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;

  if v_inv.id is null or v_inv.accepted_at is not null or v_inv.revoked_at is not null or v_inv.expires_at <= now() then
    raise exception 'La invitación no existe o ya no es válida' using errcode = 'P0001';
  end if;
  if v_inv.email <> v_email then
    raise exception 'Esta invitación es para otra dirección de correo' using errcode = '42501';
  end if;

  select om.role into v_current from public.organization_members om
  where om.organization_id = v_inv.organization_id and om.user_id = v_uid;

  if v_current is null then
    insert into public.organization_members (organization_id, user_id, role)
    values (v_inv.organization_id, v_uid, v_inv.org_role);
  end if;
  -- Si ya era miembro se conserva su rol: una invitación nunca lo rebaja ni lo sube.

  if v_inv.brand_id is not null then
    insert into public.brand_members (brand_id, organization_id, user_id, role)
    values (v_inv.brand_id, v_inv.organization_id, v_uid, v_inv.brand_role)
    on conflict (brand_id, user_id) do nothing;
  end if;

  update public.invitations i set accepted_at = now(), accepted_by = v_uid where i.id = v_inv.id;
  return v_inv.organization_id;
end $$;
