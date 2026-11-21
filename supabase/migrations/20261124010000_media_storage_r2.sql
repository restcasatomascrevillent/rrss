-- Almacenamiento de medios en Cloudflare R2 (docs/almacenamiento-r2.md).
--
--   * Integración nueva `r2` en Plataforma → Integraciones: cuenta, clave de
--     acceso (secreto en Vault), cubo, jurisdicción y a qué almacén van las
--     subidas nuevas (MEDIA_UPLOAD_BACKEND). Los mismos nombres están en
--     supabase/functions/_shared/integrations/catalog.ts y en la pantalla.
--   * `media_assets.storage_backend` dice en qué almacén está el archivo de un
--     recurso de Storage: `supabase` (cubo `brand-media`, lo de siempre) o `r2`.
--     El cliente no lo escribe: al dar de alta un recurso, un disparador lo toma
--     de `private.media_object_locations`, donde el servidor (`media-storage`)
--     apunta cada objeto que firma para subir a R2 tras comprobar que quien
--     sube edita la marca. Así vale para las altas del navegador, del
--     trabajador, de la IA y de los informes sin tocar ninguna.
--   * La cola de limpieza recuerda el almacén de cada archivo borrado.
--
-- Vuelta atrás en supabase/rollbacks/ (se niega si ya hay recursos en R2).

-- ─────────────────────── Plataforma → Integraciones ───────────────────────

alter table private.integration_setting_keys
  drop constraint integration_setting_keys_integration_check,
  add constraint integration_setting_keys_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2'));

alter table private.integration_tests
  drop constraint integration_tests_integration_check,
  add constraint integration_tests_integration_check
    check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2'));

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  ('R2_ACCOUNT_ID', 'r2', false),
  ('R2_ACCESS_KEY_ID', 'r2', true),
  ('R2_SECRET_ACCESS_KEY', 'r2', true),
  ('R2_BUCKET', 'r2', false),
  ('R2_JURISDICTION', 'r2', false),
  ('MEDIA_UPLOAD_BACKEND', 'r2', false);

-- Igual que en 20261123010000, admitiendo la integración nueva.
create or replace function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null
     or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe', 'google_drive', 'r2') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;

-- ─────────────────────────── Almacén de cada archivo ───────────────────────────

alter table public.media_assets
  add column storage_backend text not null default 'supabase' check (storage_backend in ('supabase', 'r2'));
-- Un recurso de Drive no tiene archivo en ningún almacén.
alter table public.media_assets
  add constraint media_assets_backend_storage_only check (source = 'storage' or storage_backend = 'supabase');
create index media_assets_r2_idx on public.media_assets (organization_id) where storage_backend = 'r2';

alter table public.storage_cleanup_queue
  add column storage_backend text not null default 'supabase' check (storage_backend in ('supabase', 'r2'));

-- Objetos que el servidor firmó para subir a R2 (o copió allí). Lo lee el
-- disparador de alta de `media_assets`; nadie del cliente lo ve ni lo escribe.
create table private.media_object_locations (
  storage_path text primary key check (char_length(storage_path) between 75 and 1024),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  brand_id uuid not null references public.brands (id) on delete cascade,
  backend text not null default 'r2' check (backend = 'r2'),
  registered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (storage_path like organization_id::text || '/' || brand_id::text || '/%')
);
create index media_object_locations_brand_idx on private.media_object_locations (brand_id);

alter table private.media_object_locations enable row level security;
-- Sin políticas a propósito: solo lo usan las funciones SECURITY DEFINER de abajo.
revoke all on private.media_object_locations from public, anon, authenticated;

-- Al dar de alta un recurso de Storage, su almacén sale de lo apuntado por el
-- servidor; si no hay nada apuntado, se queda el valor de la fila (por defecto,
-- Supabase: el cliente no tiene privilegio para escribir la columna).
create function private.media_assets_storage_backend() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_backend text;
begin
  if new.source = 'storage' then
    select l.backend into v_backend
    from private.media_object_locations l
    where l.storage_path = new.storage_path
      and l.organization_id = new.organization_id
      and l.brand_id = new.brand_id;
    if found then
      new.storage_backend := v_backend;
    end if;
  else
    new.storage_backend := 'supabase';
  end if;
  return new;
end $$;

create trigger media_assets_storage_backend before insert on public.media_assets
  for each row execute function private.media_assets_storage_backend();

-- La cola de limpieza recuerda dónde estaba el archivo.
create or replace function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.source = 'google_drive' then
    return old;
  end if;
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path, storage_backend)
  values (old.organization_id, old.brand_id, old.storage_path, old.storage_backend)
  on conflict (storage_path) do update set storage_backend = excluded.storage_backend;
  return old;
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Apunta que una ruta va a R2 antes de firmar su subida. Con persona
-- (`p_user_id`), tiene que editar la marca de la ruta; sin ella, es el propio
-- servidor (trabajador, IA, migración). Si ya hay un recurso con esa ruta (un
-- reintento que vuelve a escribir el mismo resultado), pasa a R2.
create function public.media_storage_register_upload(p_user_id uuid, p_path text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_brand uuid;
  v_org uuid;
begin
  if p_path is null or char_length(p_path) > 1024
     or split_part(p_path, '/', 3) in ('', 'drive')
     or p_path ~ '(^|/)\.{1,2}(/|$)' or p_path ~ '//' or position(E'\\' in p_path) > 0
     or p_path ~ '[[:cntrl:]]' then
    raise exception 'Ruta no válida' using errcode = '22023';
  end if;
  v_brand := private.storage_brand_id(p_path);
  if v_brand is null then
    raise exception 'La ruta no es de ninguna marca' using errcode = '22023';
  end if;
  if p_user_id is not null and not private.user_has_brand_capability(p_user_id, v_brand, 'edit') then
    raise exception 'Solo quien edita la marca puede subir archivos' using errcode = '42501';
  end if;
  select b.organization_id into v_org from public.brands b where b.id = v_brand;

  insert into private.media_object_locations (storage_path, organization_id, brand_id, backend, registered_by)
  values (p_path, v_org, v_brand, 'r2', p_user_id)
  on conflict (storage_path) do update set backend = 'r2', registered_by = excluded.registered_by, created_at = now();

  update public.media_assets ma set storage_backend = 'r2'
  where ma.storage_path = p_path and ma.source = 'storage' and ma.storage_backend <> 'r2';
end $$;

-- Tras borrar los archivos: quita sus anotaciones de la cola de limpieza y lo
-- apuntado de rutas que ya no tienen recurso. Devuelve cuántas rutas se han
-- quitado de la cola.
create function public.media_storage_forget_paths(p_paths text[])
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  with gone as (
    delete from public.storage_cleanup_queue q where q.storage_path = any (coalesce(p_paths, '{}')) returning 1
  )
  select count(*) into v_count from gone;
  delete from private.media_object_locations l
  where l.storage_path = any (coalesce(p_paths, '{}'))
    and not exists (select 1 from public.media_assets ma where ma.storage_path = l.storage_path);
  return v_count;
end $$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.media_assets_storage_backend() from public, anon, authenticated;
revoke all on function public.media_storage_register_upload(uuid, text) from public, anon, authenticated;
revoke all on function public.media_storage_forget_paths(text[]) from public, anon, authenticated;
grant execute on function public.media_storage_register_upload(uuid, text) to service_role;
grant execute on function public.media_storage_forget_paths(text[]) to service_role;
