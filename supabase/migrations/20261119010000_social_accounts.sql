-- Fase 3 · Cuentas de redes sociales de una marca (docs/publicacion.md).
--
--   * `social_accounts` es la cuenta conectada: de una marca, de una red
--     (`instagram`; el modelo admite `facebook`), con su identificador en la red,
--     su nombre visible, su estado y lo que se sabe de su token (caducidad, última
--     comprobación) y de su cupo de publicación. La ve quien ve la marca. Nadie la
--     escribe a mano: conectar lo hace el servidor al volver de Meta (OAuth) y
--     desconectar, quien gestiona la marca con `disconnect_social_account`.
--   * Los tokens NO están en `public`: viven en `private.social_account_secrets`,
--     que la API no expone y que ningún rol del cliente puede leer. Además van
--     cifrados por la Edge Function (AES-256-GCM, clave en los secretos de las
--     funciones, nunca en la base de datos): una copia de la base de datos no
--     basta para leerlos. Solo la clave de servicio los obtiene, con
--     `social_account_token`, y los descifra la función.
--   * El estado anti-CSRF del OAuth también vive en `private`: se guarda su
--     huella (sha256), caduca a los 10 minutos y se gasta una vez.
--   * Conectar o desconectar exige la capacidad `manage` sobre la marca: quien
--     la gestiona. El servidor vuelve a comprobarlo al recibir la respuesta de
--     Meta, con el usuario que empezó el flujo.
--   * Una marca tiene como mucho una cuenta viva por red. Volver a conectar la
--     misma cuenta renueva su token sin perder lo programado; conectar otra
--     distinta desconecta la anterior.

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Red, del catálogo de la aplicación (src/features/content/networks.ts).
  network text not null check (network in ('instagram', 'facebook')),
  -- Quién da el acceso: hoy solo la aplicación de Meta del producto.
  provider text not null default 'meta' check (provider ~ '^[a-z][a-z0-9_]{0,31}$'),
  -- Identificador de la cuenta en la red (en Instagram, el IG User ID).
  external_id text not null check (char_length(external_id) between 1 and 100),
  username text not null default '' check (char_length(username) <= 100),
  display_name text not null default '' check (char_length(display_name) <= 200),
  -- Página de Facebook a la que está unida la cuenta de Instagram (Facebook Login).
  page_id text check (page_id is null or char_length(page_id) between 1 and 100),
  -- active: publica · needs_reauth: el token ya no vale, hay que volver a
  -- conectar · disconnected: desconectada (se conserva para el historial).
  status text not null default 'active' check (status in ('active', 'needs_reauth', 'disconnected')),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 50),
  -- Null = la red no da caducidad (token de página de Meta).
  token_expires_at timestamptz,
  token_checked_at timestamptz,
  -- Cupo de publicación según la red (Instagram: content_publishing_limit).
  quota_usage integer check (quota_usage is null or quota_usage >= 0),
  quota_total integer check (quota_total is null or quota_total > 0),
  quota_checked_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  connected_by uuid references auth.users (id) on delete set null,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  unique (id, brand_id, organization_id),
  check ((status = 'disconnected') = (disconnected_at is not null))
);
create index social_accounts_brand_idx on public.social_accounts (brand_id, created_at desc);
-- Una cuenta viva por red y marca.
create unique index social_accounts_one_live_idx on public.social_accounts (brand_id, network)
  where status <> 'disconnected';

-- Tokens cifrados. En `private`: la API de datos no expone este esquema.
create table private.social_account_secrets (
  account_id uuid primary key references public.social_accounts (id) on delete cascade,
  organization_id uuid not null,
  -- Qué clave de SOCIAL_TOKEN_KEYS cifró estos valores (rotación).
  key_id text not null check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  -- base64(iv ‖ texto cifrado ‖ etiqueta), AES-256-GCM con la cuenta como dato asociado.
  access_token_ciphertext text not null check (char_length(access_token_ciphertext) between 16 and 8000),
  -- Token largo del usuario de Meta (para comprobar o renovar), si lo hay.
  refresh_token_ciphertext text check (refresh_token_ciphertext is null
                                      or char_length(refresh_token_ciphertext) between 16 and 8000),
  updated_at timestamptz not null default now()
);

-- Estado anti-CSRF del OAuth: huella del valor que viaja a Meta y vuelve.
create table private.social_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  brand_id uuid not null,
  organization_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  network text not null check (network in ('instagram', 'facebook')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes',
  used_at timestamptz,
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade
);
create index social_oauth_states_user_idx on private.social_oauth_states (user_id, created_at desc);

alter table private.social_account_secrets enable row level security;
alter table private.social_oauth_states enable row level security;

-- ─────────────────────────── Funciones internas ───────────────────────────

-- private.user_has_brand_capability (20261116110000) comprueba la capacidad de
-- quien empezó el flujo: el servidor actúa sin sesión de usuario.

-- ─────────────────────────── RPC para personas ───────────────────────────

-- Empieza la conexión: comprueba que quien llama gestiona la marca y devuelve
-- el estado anti-CSRF (la única vez que se ve; se guarda su huella). Lo llama
-- la Edge Function `social-connect` con la sesión del usuario.
create function public.social_oauth_begin(p_brand_id uuid, p_network text)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
  v_state text;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if p_brand_id is null or p_brand_id not in (select private.brand_ids_with('manage')) then
    raise exception 'Solo quien gestiona la marca puede conectar sus redes' using errcode = '42501';
  end if;
  if p_network is null or p_network not in ('instagram', 'facebook') then
    raise exception 'Esa red no se puede conectar' using errcode = '22023';
  end if;
  -- Freno contra el abuso: pocos intentos por persona en poco tiempo.
  if (select count(*) from private.social_oauth_states s
      where s.user_id = v_uid and s.created_at > now() - interval '10 minutes') >= 10 then
    raise exception 'Demasiados intentos de conexión seguidos: espera unos minutos' using errcode = 'P0001';
  end if;

  select b.organization_id into v_org from public.brands b where b.id = p_brand_id;
  v_state := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  insert into private.social_oauth_states (state_hash, brand_id, organization_id, user_id, network)
  values (encode(sha256(convert_to(v_state, 'UTF8')), 'hex'), p_brand_id, v_org, v_uid, p_network);
  return v_state;
end $$;

-- Desconecta una cuenta: deja de publicar y su token se borra. Lo programado
-- para ella queda detenido (lo hace un disparador de la migración de
-- publicaciones). La cuenta se conserva, desconectada, para el historial.
create function public.disconnect_social_account(p_account_id uuid)
returns public.social_accounts
language plpgsql security definer set search_path = '' as $$
declare
  v_account public.social_accounts;
begin
  select * into v_account from public.social_accounts a
  where a.id = p_account_id and a.brand_id in (select private.brand_ids_with('manage'))
  for update;
  if not found then
    raise exception 'Solo quien gestiona la marca puede desconectar sus redes' using errcode = '42501';
  end if;
  if v_account.status = 'disconnected' then
    return v_account;
  end if;
  delete from private.social_account_secrets s where s.account_id = v_account.id;
  update public.social_accounts a
  set status = 'disconnected', disconnected_at = now()
  where a.id = v_account.id
  returning * into v_account;
  return v_account;
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Gasta el estado anti-CSRF al volver de Meta. Falla si no existe, caducó o ya
-- se usó, y si quien empezó el flujo ya no gestiona la marca.
create function public.social_oauth_consume(p_state text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_row private.social_oauth_states;
begin
  update private.social_oauth_states s
  set used_at = now()
  where s.state_hash = encode(sha256(convert_to(coalesce(p_state, ''), 'UTF8')), 'hex')
    and s.used_at is null and s.expires_at > now()
  returning * into v_row;
  if not found then
    raise exception 'La conexión ha caducado o ya se usó: vuelve a empezar' using errcode = 'P0001';
  end if;
  if not private.user_has_brand_capability(v_row.user_id, v_row.brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede conectar sus redes' using errcode = '42501';
  end if;
  return jsonb_build_object('brand_id', v_row.brand_id, 'organization_id', v_row.organization_id,
                            'user_id', v_row.user_id, 'network', v_row.network);
end $$;

-- Da de alta (o renueva) la cuenta de una marca con su token ya cifrado. Si la
-- marca tenía otra cuenta viva en esa red, la desconecta.
create function public.social_account_connect(
  p_user_id uuid,
  p_brand_id uuid,
  p_network text,
  p_external_id text,
  p_username text,
  p_display_name text,
  p_page_id text,
  p_scopes text[],
  p_token_expires_at timestamptz,
  p_key_id text,
  p_access_token_ciphertext text,
  p_refresh_token_ciphertext text default null
) returns public.social_accounts
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_account public.social_accounts;
begin
  if not private.user_has_brand_capability(p_user_id, p_brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede conectar sus redes' using errcode = '42501';
  end if;
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id for update;

  select * into v_account from public.social_accounts a
  where a.brand_id = p_brand_id and a.network = p_network and a.status <> 'disconnected'
  for update;

  if found and v_account.external_id <> p_external_id then
    delete from private.social_account_secrets s where s.account_id = v_account.id;
    update public.social_accounts a set status = 'disconnected', disconnected_at = now() where a.id = v_account.id;
    v_account := null;
  end if;

  if v_account.id is null then
    insert into public.social_accounts (brand_id, organization_id, network, external_id, username, display_name,
                                        page_id, scopes, token_expires_at, token_checked_at, connected_by)
    values (p_brand_id, v_org, p_network, p_external_id, left(coalesce(p_username, ''), 100),
            left(coalesce(p_display_name, ''), 200), p_page_id, coalesce(p_scopes, '{}'), p_token_expires_at, now(),
            p_user_id)
    returning * into v_account;
  else
    update public.social_accounts a
    set status = 'active', username = left(coalesce(p_username, ''), 100),
        display_name = left(coalesce(p_display_name, ''), 200), page_id = p_page_id,
        scopes = coalesce(p_scopes, '{}'), token_expires_at = p_token_expires_at, token_checked_at = now(),
        last_error = null, connected_by = p_user_id, connected_at = now()
    where a.id = v_account.id
    returning * into v_account;
  end if;

  insert into private.social_account_secrets (account_id, organization_id, key_id, access_token_ciphertext,
                                              refresh_token_ciphertext)
  values (v_account.id, v_org, p_key_id, p_access_token_ciphertext, p_refresh_token_ciphertext)
  on conflict (account_id) do update
    set key_id = excluded.key_id, access_token_ciphertext = excluded.access_token_ciphertext,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext, updated_at = now();
  return v_account;
end $$;

-- Token cifrado de una cuenta viva (lo descifra la función).
create function public.social_account_token(p_account_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', s.account_id, 'key_id', s.key_id,
                            'access_token_ciphertext', s.access_token_ciphertext,
                            'refresh_token_ciphertext', s.refresh_token_ciphertext)
  from private.social_account_secrets s
  join public.social_accounts a on a.id = s.account_id
  where s.account_id = p_account_id and a.status <> 'disconnected';
$$;

-- Lo que el servidor sabe de la cuenta tras hablar con la red: estado del
-- token, su caducidad, el cupo de publicación y el último error. Los null no
-- cambian nada.
create function public.social_account_report(
  p_account_id uuid,
  p_status text default null,
  p_last_error text default null,
  p_token_expires_at timestamptz default null,
  p_quota_usage integer default null,
  p_quota_total integer default null,
  p_token_checked boolean default false
) returns public.social_accounts
language plpgsql security definer set search_path = '' as $$
declare
  v_account public.social_accounts;
begin
  if p_status is not null and p_status not in ('active', 'needs_reauth') then
    raise exception 'Estado de cuenta no válido' using errcode = '22023';
  end if;
  update public.social_accounts a
  set status = coalesce(p_status, a.status),
      last_error = case when p_status = 'active' then null
                        else coalesce(left(p_last_error, 1000), a.last_error) end,
      token_expires_at = coalesce(p_token_expires_at, a.token_expires_at),
      token_checked_at = case when coalesce(p_token_checked, false) then now() else a.token_checked_at end,
      quota_usage = coalesce(p_quota_usage, a.quota_usage),
      quota_total = coalesce(p_quota_total, a.quota_total),
      quota_checked_at = case when p_quota_usage is not null then now() else a.quota_checked_at end
  where a.id = p_account_id and a.status <> 'disconnected'
  returning * into v_account;
  if not found then
    raise exception 'La cuenta no existe o está desconectada' using errcode = 'P0001';
  end if;
  return v_account;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger social_accounts_touch before update on public.social_accounts
  for each row execute function private.touch_updated_at();

-- Alta, cambios de estado y de cuenta, y borrado. Sin tokens: no están en esta tabla.
create trigger social_accounts_audit
  after insert or update of status, external_id or delete on public.social_accounts
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.social_accounts enable row level security;

-- Ve las cuentas quien ve la marca. No hay políticas de escritura.
create policy social_accounts_select on public.social_accounts for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- Las tablas de `private` no tienen políticas: ningún rol del cliente pasa.

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.social_accounts to authenticated, service_role;
revoke all on private.social_account_secrets, private.social_oauth_states from public, anon, authenticated;

revoke all on function public.social_oauth_begin(uuid, text) from public, anon, authenticated;
revoke all on function public.disconnect_social_account(uuid) from public, anon, authenticated;
revoke all on function public.social_oauth_consume(text) from public, anon, authenticated;
revoke all on function public.social_account_connect(uuid, uuid, text, text, text, text, text, text[], timestamptz, text,
                                                      text, text) from public, anon, authenticated;
revoke all on function public.social_account_token(uuid) from public, anon, authenticated;
revoke all on function public.social_account_report(uuid, text, text, timestamptz, integer, integer, boolean)
  from public, anon, authenticated;

grant execute on function public.social_oauth_begin(uuid, text) to authenticated;
grant execute on function public.disconnect_social_account(uuid) to authenticated;
grant execute on function public.social_oauth_consume(text) to service_role;
grant execute on function public.social_account_connect(uuid, uuid, text, text, text, text, text, text[], timestamptz,
                                                         text, text, text) to service_role;
grant execute on function public.social_account_token(uuid) to service_role;
grant execute on function public.social_account_report(uuid, text, text, timestamptz, integer, integer, boolean)
  to service_role;
