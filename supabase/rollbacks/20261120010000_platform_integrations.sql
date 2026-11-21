-- Vuelta atrás de 20261120010000_platform_integrations.sql. Borra los ajustes
-- de Plataforma → Integraciones (y sus secretos de Vault): las funciones vuelven
-- a leer solo las variables de entorno. Las cuentas conectadas con token siguen
-- conectadas (como si fueran de OAuth); su comprobación diaria con la
-- aplicación del producto puede marcarlas como «hay que volver a conectarla».

drop function if exists public.social_account_connect_token(uuid, uuid, text, text, text, text, text, text[],
                                                            timestamptz, text, text);

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

create or replace function public.social_account_token(p_account_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('account_id', s.account_id, 'key_id', s.key_id,
                            'access_token_ciphertext', s.access_token_ciphertext,
                            'refresh_token_ciphertext', s.refresh_token_ciphertext)
  from private.social_account_secrets s
  join public.social_accounts a on a.id = s.account_id
  where s.account_id = p_account_id and a.status <> 'disconnected';
$$;

alter table public.social_accounts drop column if exists connection_method;

drop function if exists public.integration_record_test(uuid, text, boolean, text);
drop function if exists public.integration_settings_for_service();
drop function if exists public.admin_delete_integration_setting(text);
drop function if exists public.admin_set_integration_setting(text, text);
drop function if exists public.admin_integration_audit(integer);
drop function if exists public.admin_integration_tests();
drop function if exists public.admin_integration_settings();

do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (select s.vault_secret_id from private.integration_settings s where s.vault_secret_id is not null);
  end if;
end $$;

drop table if exists private.integration_audit;
drop table if exists private.integration_tests;
drop table if exists private.integration_settings;
drop table if exists private.integration_setting_keys;

drop function if exists private.integration_secret_value(uuid);
drop function if exists private.assert_token_keys_kept(text, text);
drop function if exists private.token_key_ids(text);
drop function if exists private.integration_hint(text);

-- La extensión de Vault no se quita: es de Supabase y la pueden usar otros (pg_cron).
