-- Plataforma → Integraciones: claves de los servicios (Meta, ComfyUI propio, IA
-- de texto e imagen, Stripe) metidas desde la interfaz por un superadministrador,
-- en lugar de en los secretos de las Edge Functions (docs/publicacion.md,
-- «Integraciones desde la interfaz»).
--
--   * Cada ajuste tiene el NOMBRE de la variable de entorno que sustituye
--     (META_APP_SECRET, COMFYUI_BASE_URL…). Las funciones leen primero estos
--     ajustes y, si uno no está, la variable de entorno: nada se rompe donde ya
--     hay secretos puestos a mano.
--   * Solo valen los nombres del catálogo `private.integration_setting_keys`:
--     desde aquí no se puede tocar nada más (ni SUPABASE_URL, ni la clave de
--     servicio, ni los interruptores de las pruebas locales con simulados).
--   * Los valores secretos se guardan en Supabase Vault (cifrados con una clave
--     que Supabase guarda FUERA de la base de datos: una copia de la base de
--     datos no basta para leerlos). En la tabla solo queda el identificador del
--     secreto en Vault y una pista para reconocerlo («…a1b2»). Los no secretos
--     (App ID, versión, URL, modelo) se guardan tal cual y se pueden enseñar.
--   * Nada de esto lo lee ni lo escribe nadie que no sea superadministrador: las
--     tablas están en `private` (la API no expone ese esquema), sin políticas y
--     sin privilegios para los roles del cliente. Los valores en claro solo los
--     obtiene la clave de servicio, con `integration_settings_for_service`.
--   * Cada cambio y cada «Probar conexión» queda en `private.integration_audit`,
--     sin el valor.
--   * Las claves de cifrado de los tokens de las redes (SOCIAL_TOKEN_KEYS) no se
--     pueden quitar mientras haya cuentas conectadas cifradas con ellas.
--
-- Además, las cuentas de Instagram se pueden conectar pegando un token
-- (`social_accounts.connection_method = 'token'`) además de por OAuth.

-- ─────────────────────────────── Vault ───────────────────────────────
-- En Supabase (alojado y local) la extensión ya viene instalada; esto solo la
-- asegura. En un Postgres sin ella (pruebas con PGlite) no se hace nada: el
-- andamiaje de las pruebas trae un sustituto.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'supabase_vault') then
    create extension if not exists supabase_vault;
  end if;
end $$;

-- ─────────────────────────────── Tablas ───────────────────────────────

-- Catálogo de ajustes que se pueden meter desde la interfaz (los mismos nombres
-- que en supabase/functions/_shared/integrations/catalog.ts y en la pantalla).
create table private.integration_setting_keys (
  setting_key text primary key check (setting_key ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  integration text not null check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe')),
  is_secret boolean not null
);

insert into private.integration_setting_keys (setting_key, integration, is_secret) values
  -- Meta (aplicación del producto) y cifrado de los tokens de las redes.
  ('META_APP_ID', 'meta', false),
  ('META_APP_SECRET', 'meta', true),
  ('META_LOGIN_CONFIG_ID', 'meta', false),
  ('META_GRAPH_API_VERSION', 'meta', false),
  ('SOCIAL_APP_URL', 'meta', false),
  ('SOCIAL_TOKEN_KEYS', 'meta', true),
  ('SOCIAL_TOKEN_KEY_ID', 'meta', false),
  -- ComfyUI propio (imagen con modelos abiertos).
  ('COMFYUI_BASE_URL', 'comfyui', false),
  ('COMFYUI_API_TOKEN', 'comfyui', true),
  ('COMFYUI_DATA_REGION', 'comfyui', false),
  -- IA de texto: proveedor y modelo por tarea, credenciales y precios.
  ('AI_TEXT_PROVIDER', 'ai_text', false),
  ('AI_TEXT_MODEL', 'ai_text', false),
  ('AI_TEXT_POST_CAPTION_PROVIDER', 'ai_text', false),
  ('AI_TEXT_POST_CAPTION_MODEL', 'ai_text', false),
  ('AI_TEXT_PROFILE_PROPOSAL_PROVIDER', 'ai_text', false),
  ('AI_TEXT_PROFILE_PROPOSAL_MODEL', 'ai_text', false),
  ('AI_TEXT_BRAND_CHECK_PROVIDER', 'ai_text', false),
  ('AI_TEXT_BRAND_CHECK_MODEL', 'ai_text', false),
  ('AI_TEXT_CAMPAIGN_PLAN_PROVIDER', 'ai_text', false),
  ('AI_TEXT_CAMPAIGN_PLAN_MODEL', 'ai_text', false),
  ('AI_TEXT_ANALYTICS_SUMMARY_PROVIDER', 'ai_text', false),
  ('AI_TEXT_ANALYTICS_SUMMARY_MODEL', 'ai_text', false),
  ('AI_VERTEX_PROJECT_ID', 'ai_text', false),
  ('AI_VERTEX_LOCATION', 'ai_text', false),
  ('AI_VERTEX_SERVICE_ACCOUNT_JSON', 'ai_text', true),
  ('ANTHROPIC_API_KEY', 'ai_text', true),
  ('MISTRAL_API_KEY', 'ai_text', true),
  ('AI_BEDROCK_REGION', 'ai_text', false),
  ('AI_BEDROCK_ACCESS_KEY_ID', 'ai_text', true),
  ('AI_BEDROCK_SECRET_ACCESS_KEY', 'ai_text', true),
  ('AI_BEDROCK_BEARER_TOKEN', 'ai_text', true),
  ('AI_PRICES', 'ai_text', false),
  ('AI_ALLOW_NON_EU_PROCESSING', 'ai_text', false),
  ('AI_TIMEOUT_MS', 'ai_text', false),
  -- IA de imagen: modelo fijado y credenciales de cada adaptador.
  ('AI_MEDIA_IMAGE_MODEL', 'ai_image', false),
  ('AI_MEDIA_ALLOW_NON_EU', 'ai_image', false),
  ('GOOGLE_VERTEX_PROJECT_ID', 'ai_image', false),
  ('GOOGLE_VERTEX_LOCATION', 'ai_image', false),
  ('GOOGLE_VERTEX_SERVICE_ACCOUNT_JSON', 'ai_image', true),
  ('BFL_API_KEY', 'ai_image', true),
  ('BFL_API_BASE_URL', 'ai_image', false),
  ('IDEOGRAM_API_KEY', 'ai_image', true),
  -- Stripe.
  ('STRIPE_SECRET_KEY', 'stripe', true),
  ('STRIPE_WEBHOOK_SECRET', 'stripe', true),
  ('BILLING_APP_URL', 'stripe', false);

-- Valor de cada ajuste: en claro si no es secreto; si lo es, solo el
-- identificador del secreto en Vault y una pista para reconocerlo.
create table private.integration_settings (
  setting_key text primary key references private.integration_setting_keys (setting_key) on delete cascade,
  plain_value text check (plain_value is null or char_length(plain_value) between 1 and 20000),
  vault_secret_id uuid,
  hint text check (hint is null or char_length(hint) <= 200),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((plain_value is null) <> (vault_secret_id is null))
);

-- Último «Probar conexión» de cada integración.
create table private.integration_tests (
  integration text primary key check (integration in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe')),
  ok boolean not null,
  message text not null check (char_length(message) <= 500),
  tested_by uuid references auth.users (id) on delete set null,
  tested_at timestamptz not null default now()
);

-- Registro de cambios y pruebas. Nunca guarda valores.
create table private.integration_audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null check (action in ('set', 'delete', 'test')),
  integration text not null,
  setting_key text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index integration_audit_created_idx on private.integration_audit (created_at desc);

alter table private.integration_setting_keys enable row level security;
alter table private.integration_settings enable row level security;
alter table private.integration_tests enable row level security;
alter table private.integration_audit enable row level security;

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Pista para reconocer un secreto sin poder reconstruirlo: de una cuenta de
-- servicio de Google, su correo (no es secreto); de lo demás, los 4 últimos
-- caracteres, y solo si el valor es largo (con uno corto, 4 caracteres serían
-- demasiada parte del secreto).
create function private.integration_hint(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_trim text := btrim(coalesce(p_value, ''));
  v_email text;
begin
  if left(v_trim, 1) = '{' then
    begin
      v_email := (v_trim::jsonb) ->> 'client_email';
    exception when others then
      v_email := null;
    end;
    if v_email is not null and char_length(v_email) <= 150 then
      return 'cuenta ' || v_email;
    end if;
    return null;
  end if;
  if char_length(v_trim) >= 16 then
    return '…' || right(v_trim, 4);
  end if;
  return null;
end $$;

-- Identificadores de un anillo de claves «id:clave,id:clave».
create function private.token_key_ids(p_ring text) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(split_part(btrim(e), ':', 1)), '{}')
  from unnest(string_to_array(coalesce(p_ring, ''), ',')) e
  where btrim(e) <> '';
$$;

-- Las claves que cifran tokens de cuentas conectadas no se pueden quitar.
create function private.assert_token_keys_kept(p_old text, p_new text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_missing text;
begin
  select k into v_missing
  from unnest(private.token_key_ids(p_old)) k
  where not (k = any (private.token_key_ids(p_new)))
    and exists (select 1 from private.social_account_secrets s where s.key_id = k)
  limit 1;
  if v_missing is not null then
    raise exception 'No se puede quitar la clave «%»: hay cuentas conectadas cuyos tokens están cifrados con ella', v_missing
      using errcode = '22023';
  end if;
end $$;

create function private.integration_secret_value(p_secret_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret from vault.decrypted_secrets ds where ds.id = p_secret_id;
$$;

-- ─────────────────────────── RPC del superadministrador ───────────────────────────

-- Ajustes guardados. Los secretos salen SIN valor: solo su pista.
create function public.admin_integration_settings()
returns table (setting_key text, integration text, is_secret boolean, value text, hint text,
               updated_at timestamptz, updated_by_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  return query
    select s.setting_key, k.integration, k.is_secret,
           case when k.is_secret then null else s.plain_value end,
           s.hint, s.updated_at, u.email::text
    from private.integration_settings s
    join private.integration_setting_keys k on k.setting_key = s.setting_key
    left join auth.users u on u.id = s.updated_by
    order by k.integration, s.setting_key;
end $$;

-- Último resultado de «Probar conexión» de cada integración.
create function public.admin_integration_tests()
returns table (integration text, ok boolean, message text, tested_at timestamptz, tested_by_email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  return query
    select t.integration, t.ok, t.message, t.tested_at, u.email::text
    from private.integration_tests t
    left join auth.users u on u.id = t.tested_by
    order by t.integration;
end $$;

-- Actividad reciente de las integraciones (sin valores).
create function public.admin_integration_audit(p_limit integer default 30)
returns table (id bigint, created_at timestamptz, action text, integration text, setting_key text,
               actor_email text, data jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  return query
    select a.id, a.created_at, a.action, a.integration, a.setting_key, u.email::text, a.data
    from private.integration_audit a
    left join auth.users u on u.id = a.actor_id
    order by a.created_at desc, a.id desc
    limit greatest(1, least(coalesce(p_limit, 30), 200));
end $$;

-- Guarda (o sustituye) un ajuste. Los secretos van a Vault.
create function public.admin_set_integration_setting(p_key text, p_value text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_key private.integration_setting_keys;
  v_row private.integration_settings;
  v_value text := btrim(coalesce(p_value, ''));
  v_secret_id uuid;
  v_name text;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  select * into v_key from private.integration_setting_keys k where k.setting_key = p_key;
  if not found then
    raise exception 'Ese ajuste no existe' using errcode = '22023';
  end if;
  if v_value = '' then
    raise exception 'El valor está vacío: para quitar el ajuste, bórralo' using errcode = '22023';
  end if;
  if char_length(v_value) > 20000 then
    raise exception 'El valor es demasiado largo' using errcode = '22023';
  end if;

  select * into v_row from private.integration_settings s where s.setting_key = p_key for update;

  if p_key = 'SOCIAL_TOKEN_KEYS' and v_row.setting_key is not null then
    perform private.assert_token_keys_kept(private.integration_secret_value(v_row.vault_secret_id), v_value);
  end if;

  if v_key.is_secret then
    v_name := 'rrss_integration_' || lower(p_key);
    v_secret_id := v_row.vault_secret_id;
    if v_secret_id is null then
      -- Un secreto huérfano con el mismo nombre (de un borrado a medias) se reutiliza.
      select vs.id into v_secret_id from vault.secrets vs where vs.name = v_name;
    end if;
    if v_secret_id is null then
      v_secret_id := vault.create_secret(v_value, v_name, 'RRSS · Plataforma → Integraciones · ' || p_key);
    else
      perform vault.update_secret(v_secret_id, v_value);
    end if;
    insert into private.integration_settings (setting_key, plain_value, vault_secret_id, hint, updated_by, updated_at)
    values (p_key, null, v_secret_id, private.integration_hint(v_value), (select auth.uid()), now())
    on conflict (setting_key) do update
      set plain_value = null, vault_secret_id = excluded.vault_secret_id, hint = excluded.hint,
          updated_by = excluded.updated_by, updated_at = now();
  else
    insert into private.integration_settings (setting_key, plain_value, vault_secret_id, hint, updated_by, updated_at)
    values (p_key, v_value, null, null, (select auth.uid()), now())
    on conflict (setting_key) do update
      set plain_value = excluded.plain_value, vault_secret_id = null, hint = null,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  insert into private.integration_audit (actor_id, action, integration, setting_key, data)
  values ((select auth.uid()), 'set', v_key.integration, p_key,
          jsonb_build_object('secret', v_key.is_secret, 'replaced', v_row.setting_key is not null));
end $$;

-- Borra un ajuste: la función vuelve a usar la variable de entorno, si la hay.
create function public.admin_delete_integration_setting(p_key text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_key private.integration_setting_keys;
  v_row private.integration_settings;
begin
  if not private.is_platform_admin() then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  select * into v_key from private.integration_setting_keys k where k.setting_key = p_key;
  if not found then
    raise exception 'Ese ajuste no existe' using errcode = '22023';
  end if;
  select * into v_row from private.integration_settings s where s.setting_key = p_key for update;
  if not found then
    return false;
  end if;
  if p_key = 'SOCIAL_TOKEN_KEYS' then
    perform private.assert_token_keys_kept(private.integration_secret_value(v_row.vault_secret_id), '');
  end if;
  delete from private.integration_settings s where s.setting_key = p_key;
  if v_row.vault_secret_id is not null then
    delete from vault.secrets vs where vs.id = v_row.vault_secret_id;
  end if;
  insert into private.integration_audit (actor_id, action, integration, setting_key, data)
  values ((select auth.uid()), 'delete', v_key.integration, p_key, jsonb_build_object('secret', v_key.is_secret));
  return true;
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Todos los ajustes guardados, en claro, para las Edge Functions. Solo la clave
-- de servicio la ejecuta; nunca llega al navegador.
create function public.integration_settings_for_service()
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(s.setting_key,
                                   coalesce(s.plain_value, private.integration_secret_value(s.vault_secret_id))),
                  '{}'::jsonb)
  from private.integration_settings s
  where s.plain_value is not null or private.integration_secret_value(s.vault_secret_id) is not null;
$$;

-- Anota el resultado de «Probar conexión» (lo hace platform-integrations tras
-- comprobar la sesión). Quien prueba tiene que ser superadministrador.
create function public.integration_record_test(p_user_id uuid, p_integration text, p_ok boolean, p_message text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or not exists (select 1 from public.platform_admins pa where pa.user_id = p_user_id) then
    raise exception 'Solo para superadministradores' using errcode = '42501';
  end if;
  if p_integration is null or p_integration not in ('meta', 'comfyui', 'ai_text', 'ai_image', 'stripe') then
    raise exception 'Esa integración no existe' using errcode = '22023';
  end if;
  insert into private.integration_tests (integration, ok, message, tested_by, tested_at)
  values (p_integration, coalesce(p_ok, false), left(coalesce(p_message, ''), 500), p_user_id, now())
  on conflict (integration) do update
    set ok = excluded.ok, message = excluded.message, tested_by = excluded.tested_by, tested_at = now();
  insert into private.integration_audit (actor_id, action, integration, data)
  values (p_user_id, 'test', p_integration, jsonb_build_object('ok', coalesce(p_ok, false)));
end $$;

-- ─────────────────── Instagram conectado con un token ───────────────────

-- Cómo se conectó la cuenta: por OAuth (Facebook Login for Business) o pegando
-- un token de página de larga duración. Con token, la comprobación diaria lo
-- valida consigo mismo (puede ser de otra aplicación de Meta).
alter table public.social_accounts
  add column connection_method text not null default 'oauth' check (connection_method in ('oauth', 'token'));

-- Igual que antes (20261119010000), y además deja la cuenta como «oauth».
create or replace function public.social_account_connect(
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
                                        page_id, scopes, token_expires_at, token_checked_at, connected_by,
                                        connection_method)
    values (p_brand_id, v_org, p_network, p_external_id, left(coalesce(p_username, ''), 100),
            left(coalesce(p_display_name, ''), 200), p_page_id, coalesce(p_scopes, '{}'), p_token_expires_at, now(),
            p_user_id, 'oauth')
    returning * into v_account;
  else
    update public.social_accounts a
    set status = 'active', username = left(coalesce(p_username, ''), 100),
        display_name = left(coalesce(p_display_name, ''), 200), page_id = p_page_id,
        scopes = coalesce(p_scopes, '{}'), token_expires_at = p_token_expires_at, token_checked_at = now(),
        last_error = null, connected_by = p_user_id, connected_at = now(), connection_method = 'oauth'
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

-- Alta con un token pegado: mismas comprobaciones que por OAuth (quien la
-- conecta gestiona la marca; el plan incluye publicación) y la cuenta queda
-- marcada como conectada con token. No hay token de usuario que guardar.
create function public.social_account_connect_token(
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
  p_access_token_ciphertext text
) returns public.social_accounts
language plpgsql security definer set search_path = '' as $$
declare
  v_account public.social_accounts;
begin
  v_account := public.social_account_connect(p_user_id, p_brand_id, p_network, p_external_id, p_username,
                                             p_display_name, p_page_id, p_scopes, p_token_expires_at, p_key_id,
                                             p_access_token_ciphertext, null);
  update public.social_accounts a set connection_method = 'token' where a.id = v_account.id
  returning * into v_account;
  return v_account;
end $$;

-- Token cifrado de una cuenta viva, ahora con cómo se conectó.
create or replace function public.social_account_token(p_account_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', s.account_id, 'key_id', s.key_id,
                            'access_token_ciphertext', s.access_token_ciphertext,
                            'refresh_token_ciphertext', s.refresh_token_ciphertext,
                            'connection_method', a.connection_method)
  from private.social_account_secrets s
  join public.social_accounts a on a.id = s.account_id
  where s.account_id = p_account_id and a.status <> 'disconnected';
$$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on private.integration_setting_keys, private.integration_settings, private.integration_tests,
  private.integration_audit from public, anon, authenticated, service_role;

revoke all on function private.integration_hint(text) from public, anon, authenticated;
revoke all on function private.token_key_ids(text) from public, anon, authenticated;
revoke all on function private.assert_token_keys_kept(text, text) from public, anon, authenticated;
revoke all on function private.integration_secret_value(uuid) from public, anon, authenticated, service_role;
revoke all on function public.admin_integration_settings() from public, anon, authenticated;
revoke all on function public.admin_integration_tests() from public, anon, authenticated;
revoke all on function public.admin_integration_audit(integer) from public, anon, authenticated;
revoke all on function public.admin_set_integration_setting(text, text) from public, anon, authenticated;
revoke all on function public.admin_delete_integration_setting(text) from public, anon, authenticated;
revoke all on function public.integration_settings_for_service() from public, anon, authenticated;
revoke all on function public.integration_record_test(uuid, text, boolean, text) from public, anon, authenticated;
revoke all on function public.social_account_connect_token(uuid, uuid, text, text, text, text, text, text[],
                                                           timestamptz, text, text) from public, anon, authenticated;

grant execute on function public.admin_integration_settings() to authenticated;
grant execute on function public.admin_integration_tests() to authenticated;
grant execute on function public.admin_integration_audit(integer) to authenticated;
grant execute on function public.admin_set_integration_setting(text, text) to authenticated;
grant execute on function public.admin_delete_integration_setting(text) to authenticated;
grant execute on function public.integration_settings_for_service() to service_role;
grant execute on function public.integration_record_test(uuid, text, boolean, text) to service_role;
grant execute on function public.social_account_connect_token(uuid, uuid, text, text, text, text, text, text[],
                                                              timestamptz, text, text) to service_role;
