-- Biblioteca con fotos de Google Drive (docs/biblioteca-drive.md).
--
--   * Una organización conecta una o varias cuentas de Google Drive
--     (`drive_connections`). La conexión la hace quien administra la
--     organización, por OAuth de Google desde la Edge Function `drive-media`.
--     El token de refresco NO está en `public`: vive cifrado (AES-256-GCM, con
--     las mismas claves que los tokens de Meta, SOCIAL_TOKEN_KEYS) en
--     `private.drive_connection_secrets`, que ningún rol del cliente lee.
--   * Un recurso de la biblioteca puede vivir en Drive (`media_assets.source =
--     'google_drive'`): se guarda solo el id del archivo de Drive, su conexión y
--     los metadatos. No hay objeto en Storage ni ocupa espacio del plan. Su
--     `storage_path` es una ruta virtual `<org>/<marca>/drive/<id de Drive>`,
--     única por marca (el mismo archivo no se da de alta dos veces en una marca)
--     y que la aplicación reconoce para pedir la imagen a `drive-media`.
--   * Esos recursos solo los da de alta el servidor (`drive_assets_import`, con
--     la clave de servicio y comprobando que quien lo pide edita la marca y que
--     la conexión es de su organización). Desde el cliente no se puede crear un
--     recurso de Drive ni cambiar a qué archivo apunta.
--   * Ver la imagen: la función comprueba con la sesión de la persona (RLS de
--     `media_assets`) que ve la marca, y firma una dirección de corta duración.

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.drive_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'google_drive' check (provider = 'google_drive'),
  -- Cuenta de Google conectada (lo dice Google, no la persona).
  account_email text not null check (char_length(account_email) between 3 and 254),
  display_name text not null default '' check (char_length(display_name) <= 200),
  -- active: sirve imágenes · needs_reauth: Google ya no acepta el acceso ·
  -- disconnected: desconectada (se conserva: los recursos la siguen nombrando).
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'disconnected')),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 20),
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'disconnected') = (disconnected_at is not null))
);
-- Una conexión viva por cuenta de Google y organización.
create unique index drive_connections_one_live_idx on public.drive_connections (organization_id, lower(account_email))
  where status <> 'disconnected';
create index drive_connections_org_idx on public.drive_connections (organization_id, created_at desc);

-- Token de refresco cifrado. En `private`: la API de datos no expone este esquema.
create table private.drive_connection_secrets (
  connection_id uuid primary key references public.drive_connections (id) on delete cascade,
  organization_id uuid not null,
  key_id text not null check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  refresh_token_ciphertext text not null check (char_length(refresh_token_ciphertext) between 16 and 8000),
  updated_at timestamptz not null default now()
);

-- Estado anti-CSRF del OAuth de Google: huella, 10 minutos, un solo uso.
create table private.drive_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz
);
create index drive_oauth_states_user_idx on private.drive_oauth_states (user_id, created_at desc);

alter table private.drive_connection_secrets enable row level security;
alter table private.drive_oauth_states enable row level security;

-- Recursos que viven en Drive.
alter table public.media_assets
  add column source text not null default 'storage' check (source in ('storage', 'google_drive')),
  add column drive_connection_id uuid references public.drive_connections (id) on delete set null,
  add column drive_file_id text check (drive_file_id is null or drive_file_id ~ '^[A-Za-z0-9_-]{10,200}$');
alter table public.media_assets
  add constraint media_assets_drive_shape check (
    (source = 'storage' and drive_file_id is null and drive_connection_id is null)
    or (source = 'google_drive' and drive_file_id is not null
        and storage_path = organization_id::text || '/' || brand_id::text || '/drive/' || drive_file_id)
  );
create index media_assets_drive_connection_idx on public.media_assets (drive_connection_id)
  where drive_connection_id is not null;

-- ─────────────────────────── Guardas ───────────────────────────

-- Desde el cliente no se crea un recurso de Drive ni se cambia su archivo o su
-- conexión: eso lo hace el servidor (drive_assets_import). Tampoco se puede
-- poner una ruta `…/drive/…` a un recurso normal: la aplicación la trataría
-- como de Drive.
create function private.media_assets_drive_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' and (new.source <> 'storage' or new.drive_file_id is not null) then
      raise exception 'Los recursos de Google Drive los da de alta el servidor' using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' and (new.source is distinct from old.source
                             or new.drive_file_id is distinct from old.drive_file_id
                             or new.drive_connection_id is distinct from old.drive_connection_id) then
      raise exception 'No se puede cambiar de dónde sale un recurso' using errcode = '42501';
    end if;
  end if;
  if new.source = 'storage' and new.storage_path like '%/drive/%' then
    raise exception 'Ruta reservada para los recursos de Google Drive' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger media_assets_drive_guard before insert or update on public.media_assets
  for each row execute function private.media_assets_drive_guard();

-- Un recurso de Drive no tiene archivo en Storage: no se anota para limpiar.
create or replace function private.queue_storage_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.source = 'google_drive' then
    return old;
  end if;
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path)
  values (old.organization_id, old.brand_id, old.storage_path)
  on conflict (storage_path) do nothing;
  return old;
end $$;

-- Lo que vive en Drive no ocupa espacio del plan.
create or replace function private.org_storage_bytes(p_organization_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(ma.bytes) from public.media_assets ma
                    where ma.organization_id = p_organization_id and ma.source = 'storage'), 0)
        + coalesce((select sum(ks.bytes) from public.brand_knowledge_sources ks
                    where ks.organization_id = p_organization_id), 0)
        + coalesce((select sum(bf.bytes) from public.brand_fonts bf where bf.organization_id = p_organization_id), 0)
         )::bigint;
$$;

-- ─────────────────────────── RPC para personas ───────────────────────────

-- Empieza la conexión: solo quien administra la organización. Devuelve el
-- estado anti-CSRF (la única vez que se ve; se guarda su huella).
create function public.drive_oauth_begin(p_organization_id uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_state text;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if p_organization_id is null or p_organization_id not in (select private.my_admin_org_ids()) then
    raise exception 'Solo quien administra la organización puede conectar Google Drive' using errcode = '42501';
  end if;
  if (select count(*) from private.drive_oauth_states s
      where s.user_id = v_uid and s.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Demasiados intentos de conexión seguidos: espera unos minutos' using errcode = 'P0001';
  end if;
  v_state := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.drive_oauth_states (state_hash, organization_id, user_id)
  values (encode(sha256(convert_to(v_state, 'UTF8')), 'hex'), p_organization_id, v_uid);
  return v_state;
end $$;

-- Desconecta: se borra el token. Los recursos ya dados de alta se quedan (sin
-- imagen hasta que se vuelva a conectar la misma cuenta).
create function public.disconnect_drive(p_connection_id uuid)
returns public.drive_connections
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.drive_connections;
begin
  select * into v_row from public.drive_connections c
  where c.id = p_connection_id and c.organization_id in (select private.my_admin_org_ids())
  for update;
  if not found then
    raise exception 'Solo quien administra la organización puede desconectar Google Drive' using errcode = '42501';
  end if;
  if v_row.status = 'disconnected' then
    return v_row;
  end if;
  delete from private.drive_connection_secrets s where s.connection_id = v_row.id;
  update public.drive_connections c set status = 'disconnected', disconnected_at = now()
  where c.id = v_row.id returning * into v_row;
  return v_row;
end $$;

-- Conexión con la que una persona puede trabajar en una marca: la marca la
-- edita ella y la conexión es de la misma organización y está viva. Si no se
-- indica conexión, la más reciente. La llama `drive-media` con la sesión de la
-- persona antes de listar o dar de alta; devuelve también quién es (el
-- servidor da de alta a su nombre).
create function public.drive_connection_for_brand(p_brand_id uuid, p_connection_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.drive_connections;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if p_brand_id is null or p_brand_id not in (select private.brand_ids_with('edit')) then
    raise exception 'Solo quien edita la marca puede añadir fotos de Google Drive' using errcode = '42501';
  end if;
  select c.* into v_row from public.drive_connections c
  join public.brands b on b.organization_id = c.organization_id
  where b.id = p_brand_id and c.status = 'active' and (p_connection_id is null or c.id = p_connection_id)
  order by c.connected_at desc
  limit 1;
  if not found then
    raise exception 'La organización no tiene Google Drive conectado' using errcode = 'P0001';
  end if;
  return jsonb_build_object('id', v_row.id, 'organization_id', v_row.organization_id,
                            'account_email', v_row.account_email, 'user_id', v_uid);
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

create function public.drive_oauth_consume(p_state text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.drive_oauth_states;
begin
  update private.drive_oauth_states s set used_at = now()
  where s.state_hash = encode(sha256(convert_to(coalesce(p_state, ''), 'UTF8')), 'hex')
    and s.used_at is null and s.expires_at > now()
  returning * into v_row;
  if not found then
    raise exception 'La conexión ha caducado o ya se usó: vuelve a empezar' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.organization_members om
                 where om.organization_id = v_row.organization_id and om.user_id = v_row.user_id
                   and om.role in ('owner', 'admin')) then
    raise exception 'Solo quien administra la organización puede conectar Google Drive' using errcode = '42501';
  end if;
  return jsonb_build_object('organization_id', v_row.organization_id, 'user_id', v_row.user_id);
end $$;

-- Alta o renovación de la conexión con su token ya cifrado.
create function public.drive_connection_save(
  p_user_id uuid,
  p_organization_id uuid,
  p_account_email text,
  p_display_name text,
  p_scopes text[],
  p_key_id text,
  p_refresh_token_ciphertext text
) returns public.drive_connections
language plpgsql security definer set search_path = '' as $$
declare
  v_row public.drive_connections;
begin
  if not exists (select 1 from public.organization_members om
                 where om.organization_id = p_organization_id and om.user_id = p_user_id
                   and om.role in ('owner', 'admin')) then
    raise exception 'Solo quien administra la organización puede conectar Google Drive' using errcode = '42501';
  end if;
  select * into v_row from public.drive_connections c
  where c.organization_id = p_organization_id and lower(c.account_email) = lower(p_account_email)
    and c.status <> 'disconnected'
  for update;
  if not found then
    insert into public.drive_connections (organization_id, account_email, display_name, scopes, connected_by)
    values (p_organization_id, lower(p_account_email), left(coalesce(p_display_name, ''), 200),
            coalesce(p_scopes, '{}'), p_user_id)
    returning * into v_row;
  else
    update public.drive_connections c
    set status = 'active', display_name = left(coalesce(p_display_name, ''), 200), scopes = coalesce(p_scopes, '{}'),
        last_error = null, connected_by = p_user_id, connected_at = now()
    where c.id = v_row.id returning * into v_row;
  end if;
  -- Los recursos de una conexión anterior de la misma cuenta vuelven a tener imagen.
  update public.media_assets a set drive_connection_id = v_row.id
  where a.organization_id = p_organization_id and a.source = 'google_drive'
    and a.drive_connection_id in (select c.id from public.drive_connections c
                                  where c.organization_id = p_organization_id and c.status = 'disconnected'
                                    and lower(c.account_email) = lower(p_account_email));
  insert into private.drive_connection_secrets (connection_id, organization_id, key_id, refresh_token_ciphertext)
  values (v_row.id, p_organization_id, p_key_id, p_refresh_token_ciphertext)
  on conflict (connection_id) do update
    set key_id = excluded.key_id, refresh_token_ciphertext = excluded.refresh_token_ciphertext, updated_at = now();
  return v_row;
end $$;

-- Token cifrado de una conexión viva (lo descifra la función).
create function public.drive_connection_token(p_connection_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('connection_id', s.connection_id, 'organization_id', s.organization_id,
                            'account_email', c.account_email, 'key_id', s.key_id,
                            'refresh_token_ciphertext', s.refresh_token_ciphertext)
  from private.drive_connection_secrets s
  join public.drive_connections c on c.id = s.connection_id
  where s.connection_id = p_connection_id and c.status = 'active';
$$;

-- Google ya no acepta el acceso (o vuelve a aceptarlo).
create function public.drive_connection_report(p_connection_id uuid, p_status text, p_last_error text default null)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_status not in ('active', 'needs_reauth') then
    raise exception 'Estado de conexión no válido' using errcode = '22023';
  end if;
  update public.drive_connections c
  set status = p_status, last_error = case when p_status = 'active' then null else left(p_last_error, 1000) end
  where c.id = p_connection_id and c.status <> 'disconnected';
end $$;

-- Da de alta en la biblioteca de una marca archivos de Drive ya comprobados por
-- la función (que los ha leído de Google con la conexión). `p_files` es una
-- lista de {id, name, mime_type, bytes, width, height}. Si el archivo ya está
-- en la marca, se devuelve el que había. Solo imágenes que el navegador pinta.
create function public.drive_assets_import(
  p_user_id uuid,
  p_brand_id uuid,
  p_connection_id uuid,
  p_files jsonb,
  p_folder text default '',
  p_tags text[] default '{}'
) returns setof public.media_assets
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_file jsonb;
  v_path text;
  v_row public.media_assets;
begin
  if not private.user_has_brand_capability(p_user_id, p_brand_id, 'edit') then
    raise exception 'Solo quien edita la marca puede añadir fotos de Google Drive' using errcode = '42501';
  end if;
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id;
  if not exists (select 1 from public.drive_connections c
                 where c.id = p_connection_id and c.organization_id = v_org and c.status = 'active') then
    raise exception 'Esa conexión de Google Drive no es de la organización o no está activa' using errcode = '42501';
  end if;
  if jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 or jsonb_array_length(p_files) > 100 then
    raise exception 'Hay que elegir entre 1 y 100 archivos' using errcode = '22023';
  end if;

  for v_file in select * from jsonb_array_elements(p_files) loop
    if coalesce(v_file ->> 'mime_type', '') not in ('image/jpeg', 'image/png', 'image/webp', 'image/gif') then
      raise exception 'Solo se pueden añadir imágenes JPEG, PNG, WebP o GIF' using errcode = '22023';
    end if;
    v_path := v_org::text || '/' || p_brand_id::text || '/drive/' || (v_file ->> 'id');
    select * into v_row from public.media_assets a where a.storage_path = v_path;
    if not found then
      insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type,
                                       bytes, width, height, folder, tags, created_by, source, drive_connection_id,
                                       drive_file_id)
      values (p_brand_id, v_org, 'image', 'import', v_path, left(coalesce(nullif(v_file ->> 'name', ''), 'Drive'), 255),
              v_file ->> 'mime_type', greatest(coalesce((v_file ->> 'bytes')::bigint, 0), 0),
              nullif((v_file ->> 'width')::integer, 0), nullif((v_file ->> 'height')::integer, 0),
              left(coalesce(p_folder, ''), 200), coalesce(p_tags, '{}'), p_user_id, 'google_drive', p_connection_id,
              v_file ->> 'id')
      returning * into v_row;
    end if;
    return next v_row;
  end loop;
end $$;

-- Con qué conexión y archivo se sirve un recurso de Drive. Para el servidor
-- (el trabajador de medios pide así la imagen de un recurso).
create function public.drive_asset_source(p_storage_path text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('asset_id', a.id, 'brand_id', a.brand_id, 'organization_id', a.organization_id,
                            'connection_id', a.drive_connection_id, 'file_id', a.drive_file_id,
                            'mime_type', a.mime_type)
  from public.media_assets a
  where a.storage_path = p_storage_path and a.source = 'google_drive';
$$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger drive_connections_touch before update on public.drive_connections
  for each row execute function private.touch_updated_at();
create trigger drive_connections_audit
  after insert or update of status or delete on public.drive_connections
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.drive_connections enable row level security;

-- Ven las conexiones los miembros de la organización (para saber si pueden
-- añadir fotos de Drive). No hay políticas de escritura: todo pasa por RPC.
create policy drive_connections_select on public.drive_connections for select to authenticated
  using (organization_id in (select private.my_org_ids()));

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on public.drive_connections from public, anon, authenticated;
grant select on public.drive_connections to authenticated;
grant all on public.drive_connections to service_role;
revoke all on private.drive_connection_secrets, private.drive_oauth_states from public, anon, authenticated;

revoke all on function private.media_assets_drive_guard() from public, anon, authenticated;
revoke all on function public.drive_oauth_begin(uuid) from public, anon, authenticated;
revoke all on function public.disconnect_drive(uuid) from public, anon, authenticated;
revoke all on function public.drive_connection_for_brand(uuid, uuid) from public, anon, authenticated;
revoke all on function public.drive_oauth_consume(text) from public, anon, authenticated;
revoke all on function public.drive_connection_save(uuid, uuid, text, text, text[], text, text)
  from public, anon, authenticated;
revoke all on function public.drive_connection_token(uuid) from public, anon, authenticated;
revoke all on function public.drive_connection_report(uuid, text, text) from public, anon, authenticated;
revoke all on function public.drive_assets_import(uuid, uuid, uuid, jsonb, text, text[])
  from public, anon, authenticated;
revoke all on function public.drive_asset_source(text) from public, anon, authenticated;

grant execute on function public.drive_oauth_begin(uuid) to authenticated;
grant execute on function public.disconnect_drive(uuid) to authenticated;
grant execute on function public.drive_connection_for_brand(uuid, uuid) to authenticated;
grant execute on function public.drive_oauth_consume(text) to service_role;
grant execute on function public.drive_connection_save(uuid, uuid, text, text, text[], text, text) to service_role;
grant execute on function public.drive_connection_token(uuid) to service_role;
grant execute on function public.drive_connection_report(uuid, text, text) to service_role;
grant execute on function public.drive_assets_import(uuid, uuid, uuid, jsonb, text, text[]) to service_role;
grant execute on function public.drive_asset_source(text) to service_role;
