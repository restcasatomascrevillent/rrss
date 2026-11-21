-- Actividad: aceptar una invitación se cuenta como lo que es.
--
-- Antes, al aceptar una invitación el registro guardaba las altas de miembro
-- como si alguien las hubiera hecho a mano, y la actividad decía «Ana dio acceso
-- a Ana como Editor» (más «Ana añadió a Ana como Miembro» y «Ana aceptó la
-- invitación enviada a…»).
--
-- Ahora `accept_invitation` marca su transacción con `rrss.audit_via =
-- 'invitation'` y `private.audit` copia esa marca en `data.via` de cada fila
-- que registra. La interfaz (src/features/audit/describe.ts) usa la marca para
-- decir una sola vez «aceptó la invitación y entró como Editor» y no repetir
-- las altas de miembro que trae consigo.
--
-- La marca la pone solo una función del servidor con set_config(..., true)
-- (local a la transacción). Nadie puede fijarla desde la API: PostgREST no
-- expone set_config. Y aunque se pudiera, solo cambiaría la redacción.

create or replace function private.audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_row jsonb;
  v_org uuid;
  v_brand uuid;
  -- Contexto de la operación que dispara el cambio (p. ej. 'invitation'), si la
  -- función que lo hace lo ha marcado con set_config(..., true): dura solo la transacción.
  v_via text := nullif(current_setting('rrss.audit_via', true), '');
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
    (v_row - 'data' - 'provenance' - 'token_hash' - 'settings')
      || case when v_via is null then '{}'::jsonb else jsonb_build_object('via', v_via) end
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

  -- Las altas de esta transacción se registran como «por invitación», para que la
  -- actividad diga «aceptó la invitación» y no «X dio acceso a X».
  perform set_config('rrss.audit_via', 'invitation', true);

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
  perform set_config('rrss.audit_via', '', true);
  return v_inv.organization_id;
end $$;

revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.accept_invitation(text) to authenticated;
