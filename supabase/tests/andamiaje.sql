-- Andamiaje para probar las migraciones en un Postgres «pelado» (PGlite o
-- Postgres local): reproduce lo mínimo que Supabase ya trae de serie (roles,
-- esquema auth, esquema storage). NO es una migración y nunca se aplica en
-- Supabase.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as $$ select auth.jwt() ->> 'role' $$;

create schema storage;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;

grant usage on schema public, auth, storage to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;

-- Sustituto mínimo de Supabase Vault (`vault.create_secret`, `vault.update_secret`,
-- `vault.secrets` y la vista `vault.decrypted_secrets`), con la misma forma.
-- NO cifra: guarda el valor en base64 para que las pruebas puedan comprobar que
-- el texto en claro no aparece en ninguna tabla. El Vault de verdad cifra con
-- una clave que no está en la base de datos.
create schema vault;
create table vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  key_id uuid,
  nonce bytea,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create view vault.decrypted_secrets as
  select s.id, s.name, s.description, s.secret,
         convert_from(decode(s.secret, 'base64'), 'UTF8') as decrypted_secret,
         s.key_id, s.nonce, s.created_at, s.updated_at
  from vault.secrets s;
create function vault.create_secret(new_secret text, new_name text default null, new_description text default '',
                                    new_key_id uuid default null) returns uuid
language sql as $$
  insert into vault.secrets (name, description, secret, key_id)
  values (new_name, coalesce(new_description, ''), encode(convert_to(new_secret, 'UTF8'), 'base64'), new_key_id)
  returning id;
$$;
create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null,
                                    new_description text default null, new_key_id uuid default null) returns void
language sql as $$
  update vault.secrets s
  set secret = coalesce(encode(convert_to(new_secret, 'UTF8'), 'base64'), s.secret),
      name = coalesce(new_name, s.name), description = coalesce(new_description, s.description),
      updated_at = now()
  where s.id = secret_id;
$$;
revoke all on schema vault from public;
