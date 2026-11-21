-- RGPD (parte de la Fase 6): consentimiento, acceso y portabilidad, supresión.
-- Ver docs/rgpd.md. Esto no es asesoría legal: lo que aquí se decide (qué se
-- exporta, qué se anonimiza, qué se conserva) es una propuesta para revisar con
-- un abogado.
--
-- 1. Aceptación de las condiciones y de la política de privacidad
--    (`legal_acceptances`). Se apunta al registrarse: el formulario manda las
--    versiones aceptadas en los metadatos del alta y un disparador sobre
--    auth.users las guarda con la hora del servidor. Quien no las aceptó al
--    registrarse (cuentas anteriores) las acepta desde su cuenta con
--    `accept_legal_documents`. Cada fila es una prueba: nadie la cambia.
-- 2. Derecho de acceso y portabilidad:
--    * `export_my_data()`: los datos personales de quien llama (perfil,
--      pertenencias, aceptaciones, actividad hecha por ella, encargos,
--      comentarios, piezas, versiones, recursos y generaciones que creó). Sin
--      parámetros: solo puede devolver los de la sesión.
--    * `export_organization_data(org)`: solo propietarios. SECURITY INVOKER: la
--      RLS sigue mandando, de modo que ni con un fallo aquí saldría nada que el
--      propietario no pueda ver ya. Los archivos van como lista de rutas; la
--      aplicación las firma con la sesión del propietario.
-- 3. Derecho de supresión. El borrado lo hacen dos Edge Functions con la clave
--    de servicio (`delete-account`, `delete-organization`); las funciones de
--    aquí solo las puede ejecutar el servidor, que pasa el usuario sacado del
--    token de sesión, nunca del cuerpo de la petición. Aun así, cada función
--    comprueba los permisos de ese usuario (como `ai_reserve_generation`).
--    * Borrar la cuenta: si es la única propietaria de una organización con más
--      miembros, se niega (RG001) hasta que traspase la propiedad o borre la
--      organización. Las organizaciones donde es el único miembro se borran con
--      la cuenta. La autoría queda anónima: las claves foráneas de autor ya son
--      `on delete set null`, y los disparadores de abajo limpian el registro de
--      auditoría (que no tiene claves foráneas) y las invitaciones que aceptó.
--      El trabajo de los demás no se toca.
--    * Borrar una organización: solo un propietario y escribiendo el nombre
--      exacto. Borra en cascada marcas, perfiles, contenidos, encargos,
--      biblioteca, cupos, trabajos e invitaciones; del registro de auditoría
--      queda solo la constancia del borrado. Devuelve las rutas de Storage y
--      las deja anotadas en `storage_cleanup_queue` por si falla su borrado.
--      El libro de consumo de IA (`ai_usage`) se conserva a propósito: no
--      tiene datos personales y es la base de la facturación.

-- ───────────────────── 1. Aceptación de documentos legales ─────────────────────

create table public.legal_acceptances (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- terms: condiciones de uso · privacy: política de privacidad.
  document text not null check (document in ('terms', 'privacy')),
  -- Versión del documento, con forma de fecha (AAAA-MM-DD, con «.n» opcional).
  version text not null check (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,3})?$'),
  accepted_at timestamptz not null default now(),
  -- signup: casilla del registro · app: aceptadas después, desde la cuenta.
  source text not null check (source in ('signup', 'app')),
  unique (user_id, document, version)
);
create index legal_acceptances_user_idx on public.legal_acceptances (user_id, accepted_at desc);

alter table public.legal_acceptances enable row level security;

-- Cada persona ve solo las suyas; nadie las escribe desde el cliente.
create policy legal_acceptances_select_own on public.legal_acceptances for select to authenticated
  using (user_id = (select auth.uid()));

revoke all on public.legal_acceptances from anon, authenticated, public;
grant select on public.legal_acceptances to authenticated;
grant all on public.legal_acceptances to service_role;

create function private.legal_version_valid(p_version text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(\.[0-9]{1,3})?$', false);
$$;

-- Alta de usuario: si el registro trae {"legal": {"terms_version": …,
-- "privacy_version": …}} en los metadatos, se apunta la aceptación con la hora
-- del servidor. Un alta sin ese dato (invitaciones antiguas, altas a mano) no
-- falla: la persona las aceptará desde su cuenta.
create function private.record_signup_legal_acceptance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_legal jsonb := new.raw_user_meta_data -> 'legal';
begin
  if jsonb_typeof(v_legal) = 'object' then
    if private.legal_version_valid(v_legal ->> 'terms_version') then
      insert into public.legal_acceptances (user_id, document, version, source)
      values (new.id, 'terms', v_legal ->> 'terms_version', 'signup')
      on conflict (user_id, document, version) do nothing;
    end if;
    if private.legal_version_valid(v_legal ->> 'privacy_version') then
      insert into public.legal_acceptances (user_id, document, version, source)
      values (new.id, 'privacy', v_legal ->> 'privacy_version', 'signup')
      on conflict (user_id, document, version) do nothing;
    end if;
  end if;
  return new;
end $$;

create trigger on_auth_user_created_legal after insert on auth.users
  for each row execute function private.record_signup_legal_acceptance();

-- Aceptar desde la cuenta (o volver a aceptar una versión nueva).
create function public.accept_legal_documents(p_terms_version text, p_privacy_version text)
returns setof public.legal_acceptances
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if not private.legal_version_valid(p_terms_version) or not private.legal_version_valid(p_privacy_version) then
    raise exception 'La versión de los documentos no es válida' using errcode = '22023';
  end if;
  insert into public.legal_acceptances (user_id, document, version, source)
  values (v_uid, 'terms', p_terms_version, 'app'), (v_uid, 'privacy', p_privacy_version, 'app')
  on conflict (user_id, document, version) do nothing;
  return query select * from public.legal_acceptances la where la.user_id = v_uid order by la.accepted_at desc, la.id desc;
end $$;

-- ───────────────────── 2. Acceso y portabilidad ─────────────────────

-- Datos personales de quien llama. SECURITY DEFINER porque incluye cosas que la
-- RLS ya no le deja ver (actividad en organizaciones de las que salió, su
-- propio registro de auditoría sin ser administradora), pero TODO se filtra
-- por auth.uid(): no hay forma de pedir los datos de otra persona.
-- No incluye los documentos de las piezas ni los resultados de la IA: son
-- trabajo de la organización y salen en su exportación.
create function public.export_my_data()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_user jsonb;
  v_email text;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;

  select to_jsonb(u) into v_user from auth.users u where u.id = v_uid;
  v_email := lower(coalesce(v_user ->> 'email', ''));

  return jsonb_build_object(
    'format', 'rrss.personal-data',
    'version', 1,
    'generated_at', now(),
    'notice', 'Copia de tus datos personales en la plataforma (art. 15 y 20 del RGPD). '
      || 'Los documentos de las piezas, los archivos y los resultados de la IA pertenecen a cada organización: '
      || 'pídeselos a su propietario o usa «Exportar los datos de la organización» si lo eres.',
    -- Solo campos de la cuenta; nunca la contraseña cifrada ni los tokens.
    'account', jsonb_build_object(
      'id', v_uid,
      'email', v_user -> 'email',
      'phone', v_user -> 'phone',
      'created_at', v_user -> 'created_at',
      'email_confirmed_at', v_user -> 'email_confirmed_at',
      'last_sign_in_at', v_user -> 'last_sign_in_at',
      'user_metadata', coalesce(v_user -> 'raw_user_meta_data', '{}'::jsonb)
    ),
    'profile', (select to_jsonb(p) from public.profiles p where p.user_id = v_uid),
    'platform_admin', exists (select 1 from public.platform_admins pa where pa.user_id = v_uid),
    'legal_acceptances', coalesce((
      select jsonb_agg(jsonb_build_object('document', la.document, 'version', la.version,
                                          'accepted_at', la.accepted_at, 'source', la.source)
                       order by la.accepted_at, la.id)
      from public.legal_acceptances la where la.user_id = v_uid), '[]'::jsonb),
    'organizations', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', om.organization_id, 'name', o.name,
                                          'role', om.role, 'joined_at', om.created_at)
                       order by om.created_at)
      from public.organization_members om
      join public.organizations o on o.id = om.organization_id
      where om.user_id = v_uid), '[]'::jsonb),
    'brand_roles', coalesce((
      select jsonb_agg(jsonb_build_object('brand_id', bm.brand_id, 'brand_name', b.name,
                                          'organization_id', bm.organization_id, 'role', bm.role,
                                          'since', bm.created_at)
                       order by bm.created_at)
      from public.brand_members bm
      join public.brands b on b.id = bm.brand_id
      where bm.user_id = v_uid), '[]'::jsonb),
    -- Invitaciones que envió (las direcciones las escribió ella) y las que recibió.
    'invitations_sent', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', i.organization_id, 'email', i.email,
                                          'org_role', i.org_role, 'brand_id', i.brand_id, 'brand_role', i.brand_role,
                                          'created_at', i.created_at, 'expires_at', i.expires_at,
                                          'accepted_at', i.accepted_at, 'revoked_at', i.revoked_at)
                       order by i.created_at)
      from public.invitations i where i.invited_by = v_uid), '[]'::jsonb),
    'invitations_received', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', i.organization_id, 'organization_name', o.name,
                                          'org_role', i.org_role, 'brand_role', i.brand_role,
                                          'created_at', i.created_at, 'accepted_at', i.accepted_at)
                       order by i.created_at)
      from public.invitations i
      join public.organizations o on o.id = i.organization_id
      where i.accepted_by = v_uid or (v_email <> '' and i.email = v_email)), '[]'::jsonb),
    -- Lo que hizo ella según el registro de auditoría.
    'activity', coalesce((
      select jsonb_agg(jsonb_build_object('at', al.created_at, 'organization_id', al.organization_id,
                                          'brand_id', al.brand_id, 'action', al.action,
                                          'entity_type', al.entity_type, 'entity_id', al.entity_id,
                                          'data', al.data)
                       order by al.created_at, al.id)
      from public.audit_logs al where al.actor_id = v_uid), '[]'::jsonb),
    'content_items_created', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'brand_id', c.brand_id, 'title', c.title,
                                          'network', c.network, 'format', c.format, 'status', c.status,
                                          'created_at', c.created_at)
                       order by c.created_at)
      from public.content_items c where c.created_by = v_uid), '[]'::jsonb),
    'content_versions_created', coalesce((
      select jsonb_agg(jsonb_build_object('content_id', v.content_id, 'brand_id', v.brand_id,
                                          'version', v.version, 'change_note', v.change_note,
                                          'restored_from', v.restored_from, 'created_at', v.created_at)
                       order by v.created_at)
      from public.content_versions v where v.created_by = v_uid), '[]'::jsonb),
    'content_requests', coalesce((
      select jsonb_agg(jsonb_build_object('id', r.id, 'brand_id', r.brand_id, 'title', r.title,
                                          'brief', r.brief, 'network', r.network, 'format', r.format,
                                          'media_kind', r.media_kind, 'desired_date', r.desired_date,
                                          'status', r.status, 'created_at', r.created_at)
                       order by r.created_at)
      from public.content_requests r where r.requested_by = v_uid), '[]'::jsonb),
    'content_request_comments', coalesce((
      select jsonb_agg(jsonb_build_object('request_id', cm.request_id, 'brand_id', cm.brand_id,
                                          'kind', cm.kind, 'status', cm.status, 'body', cm.body,
                                          'created_at', cm.created_at)
                       order by cm.created_at)
      from public.content_request_comments cm where cm.author_id = v_uid), '[]'::jsonb),
    'media_assets_uploaded', coalesce((
      select jsonb_agg(jsonb_build_object('id', a.id, 'brand_id', a.brand_id, 'kind', a.kind,
                                          'file_name', a.file_name, 'mime_type', a.mime_type, 'bytes', a.bytes,
                                          'folder', a.folder, 'tags', a.tags, 'created_at', a.created_at)
                       order by a.created_at)
      from public.media_assets a where a.created_by = v_uid), '[]'::jsonb),
    'ai_generations_requested', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'brand_id', g.brand_id, 'task', g.task,
                                          'purpose', g.purpose, 'provider', g.provider, 'model', g.model,
                                          'status', g.status, 'created_at', g.created_at)
                       order by g.created_at)
      from public.ai_generations g where g.requested_by = v_uid), '[]'::jsonb),
    'jobs_created', coalesce((
      select jsonb_agg(jsonb_build_object('id', j.id, 'brand_id', j.brand_id, 'kind', j.kind,
                                          'status', j.status, 'created_at', j.created_at)
                       order by j.created_at)
      from public.jobs j where j.created_by = v_uid), '[]'::jsonb)
  );
end $$;

-- Datos de una organización para su propietario. SECURITY INVOKER a propósito:
-- además de exigir el rol de propietario, cada lectura pasa por la RLS de quien
-- llama. Incluye todas las versiones del perfil y de cada pieza (el documento
-- completo) y la lista de archivos; no incluye el registro de auditoría ni el
-- consumo de IA (están en sus pantallas) ni las huellas de las invitaciones.
create function public.export_organization_data(p_organization_id uuid)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.organization_members om
    where om.organization_id = p_organization_id and om.user_id = (select auth.uid()) and om.role = 'owner'
  ) then
    raise exception 'Solo un propietario puede exportar los datos de la organización' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'format', 'rrss.organization-export',
    'version', 1,
    'generated_at', now(),
    'organization', (
      select jsonb_build_object('id', o.id, 'name', o.name, 'kind', o.kind, 'settings', o.settings,
                                'created_at', o.created_at, 'updated_at', o.updated_at)
      from public.organizations o where o.id = p_organization_id),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', om.user_id, 'full_name', p.full_name, 'email', p.email,
                                          'role', om.role, 'joined_at', om.created_at)
                       order by om.created_at)
      from public.organization_members om
      left join public.profiles p on p.user_id = om.user_id
      where om.organization_id = p_organization_id), '[]'::jsonb),
    'pending_invitations', coalesce((
      select jsonb_agg(jsonb_build_object('email', i.email, 'org_role', i.org_role, 'brand_id', i.brand_id,
                                          'brand_role', i.brand_role, 'created_at', i.created_at,
                                          'expires_at', i.expires_at)
                       order by i.created_at)
      from public.invitations i
      where i.organization_id = p_organization_id and i.accepted_at is null and i.revoked_at is null
        and i.expires_at > now()), '[]'::jsonb),
    'brands', coalesce((
      select jsonb_agg(
        to_jsonb(b) || jsonb_build_object(
          'members', coalesce((
            select jsonb_agg(jsonb_build_object('user_id', bm.user_id, 'role', bm.role, 'since', bm.created_at)
                             order by bm.created_at)
            from public.brand_members bm where bm.brand_id = b.id), '[]'::jsonb),
          'profiles', coalesce((
            select jsonb_agg(jsonb_build_object('version', bp.version, 'status', bp.status,
                                                'schema_version', bp.schema_version, 'data', bp.data,
                                                'provenance', bp.provenance, 'change_note', bp.change_note,
                                                'created_by', bp.created_by, 'created_at', bp.created_at)
                             order by bp.version)
            from public.brand_profiles bp where bp.brand_id = b.id), '[]'::jsonb),
          'knowledge_sources', coalesce((
            select jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title,
                                                'storage_path', s.storage_path, 'url', s.url,
                                                'mime_type', s.mime_type, 'bytes', s.bytes, 'status', s.status,
                                                'created_at', s.created_at)
                             order by s.created_at)
            from public.brand_knowledge_sources s where s.brand_id = b.id), '[]'::jsonb),
          'contents', coalesce((
            select jsonb_agg(to_jsonb(c) || jsonb_build_object('versions', coalesce((
                               select jsonb_agg(jsonb_build_object('version', v.version,
                                                                   'schema_version', v.schema_version,
                                                                   'data', v.data, 'change_note', v.change_note,
                                                                   'restored_from', v.restored_from,
                                                                   'created_by', v.created_by,
                                                                   'created_at', v.created_at)
                                                order by v.version)
                               from public.content_versions v where v.content_id = c.id), '[]'::jsonb))
                             order by c.created_at)
            from public.content_items c where c.brand_id = b.id), '[]'::jsonb),
          'requests', coalesce((
            select jsonb_agg((to_jsonb(r) - 'claim_token') || jsonb_build_object('comments', coalesce((
                               select jsonb_agg(jsonb_build_object('kind', cm.kind, 'status', cm.status,
                                                                   'body', cm.body, 'author_id', cm.author_id,
                                                                   'created_at', cm.created_at)
                                                order by cm.created_at, cm.id)
                               from public.content_request_comments cm where cm.request_id = r.id), '[]'::jsonb))
                             order by r.created_at)
            from public.content_requests r where r.brand_id = b.id), '[]'::jsonb),
          'assets', coalesce((
            select jsonb_agg(jsonb_build_object('id', a.id, 'kind', a.kind, 'origin', a.origin,
                                                'storage_path', a.storage_path, 'file_name', a.file_name,
                                                'mime_type', a.mime_type, 'bytes', a.bytes, 'width', a.width,
                                                'height', a.height, 'duration_ms', a.duration_ms,
                                                'sha256', a.sha256, 'folder', a.folder, 'tags', a.tags,
                                                'rights', a.rights, 'provenance', a.provenance,
                                                'created_by', a.created_by, 'created_at', a.created_at)
                             order by a.created_at)
            from public.media_assets a where a.brand_id = b.id), '[]'::jsonb)
        )
        order by b.created_at)
      from public.brands b where b.organization_id = p_organization_id), '[]'::jsonb)
  );
end $$;

-- ───────────────────── 3. Supresión ─────────────────────

-- Qué pasaría al borrar la cuenta de un usuario:
--   blocking: organizaciones donde es el único propietario y hay más miembros
--             (hay que traspasar la propiedad o borrarlas antes);
--   deleted_with_account: organizaciones donde es el único miembro (se borran con la cuenta).
create function private.account_deletion_plan(p_user_id uuid)
returns jsonb
language sql stable security definer set search_path = '' as $$
  with mine as (
    select om.organization_id, o.name,
      (select count(*) from public.organization_members x where x.organization_id = om.organization_id) as members,
      (select count(*) from public.organization_members x
       where x.organization_id = om.organization_id and x.role = 'owner' and x.user_id <> p_user_id) as other_owners
    from public.organization_members om
    join public.organizations o on o.id = om.organization_id
    where om.user_id = p_user_id and om.role = 'owner'
  )
  select jsonb_build_object(
    'blocking', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', m.organization_id, 'name', m.name, 'members', m.members)
                       order by m.name)
      from mine m where m.other_owners = 0 and m.members > 1), '[]'::jsonb),
    'deleted_with_account', coalesce((
      select jsonb_agg(jsonb_build_object('organization_id', m.organization_id, 'name', m.name) order by m.name)
      from mine m where m.members = 1), '[]'::jsonb)
  );
$$;

-- Lo mismo para la persona con sesión: la pantalla lo enseña antes de borrar.
create function public.my_account_deletion_check()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  return private.account_deletion_plan(v_uid);
end $$;

-- Rutas de Storage de una organización: lo que conoce la base de datos
-- (biblioteca, fuentes, anotaciones pendientes) y lo que haya en el cubo bajo
-- `<organización>/`. Con la clave de servicio la función, además, lista el
-- cubo por la API: así no queda nada aunque `storage.objects` no fuese legible.
create function private.organization_storage_paths(p_organization_id uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct p order by p), '{}'::text[])
  from (
    select a.storage_path as p from public.media_assets a where a.organization_id = p_organization_id
    union all
    select s.storage_path from public.brand_knowledge_sources s
    where s.organization_id = p_organization_id and s.storage_path is not null
    union all
    select q.storage_path from public.storage_cleanup_queue q where q.organization_id = p_organization_id
    union all
    select o.name from storage.objects o
    where o.bucket_id = 'brand-media' and o.name like p_organization_id::text || '/%'
  ) paths;
$$;

-- Borra una organización entera. Lo usan las dos funciones de supresión, que
-- ya han comprobado los permisos. Devuelve las rutas de sus archivos.
create function private.delete_organization_data(p_organization_id uuid, p_actor uuid)
returns text[]
language plpgsql security definer set search_path = '' as $$
declare
  v_paths text[];
begin
  perform 1 from public.organizations o where o.id = p_organization_id for update;
  if not found then
    raise exception 'La organización no existe' using errcode = 'P0001';
  end if;

  v_paths := private.organization_storage_paths(p_organization_id);
  -- Anotadas en la cola de limpieza: si el borrado en Storage falla, quedan
  -- pendientes para el servidor (sin claves foráneas: sobreviven al borrado).
  insert into public.storage_cleanup_queue (organization_id, brand_id, storage_path)
  select p_organization_id, split_part(p, '/', 2)::uuid, p
  from unnest(v_paths) p
  where split_part(p, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  on conflict (storage_path) do nothing;

  delete from public.organizations o where o.id = p_organization_id;

  -- Del registro de auditoría solo queda la constancia del borrado (la deja el
  -- propio disparador de auditoría), con quién lo pidió.
  delete from public.audit_logs al
  where al.organization_id = p_organization_id
    and not (al.entity_type = 'organizations' and al.action = 'delete');
  update public.audit_logs al set actor_id = p_actor
  where al.organization_id = p_organization_id and al.entity_type = 'organizations' and al.action = 'delete'
    and al.actor_id is null;

  return v_paths;
end $$;

-- Borrar una organización (solo el servidor, en nombre de un propietario).
--   42501  quien lo pide no es propietario de la organización
--   RG002  la confirmación no coincide con el nombre de la organización
create function public.gdpr_delete_organization(p_user_id uuid, p_organization_id uuid, p_confirmation text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_name text;
  v_paths text[];
begin
  select o.name into v_name
  from public.organizations o
  join public.organization_members om on om.organization_id = o.id
  where o.id = p_organization_id and om.user_id = p_user_id and om.role = 'owner';
  if v_name is null then
    raise exception 'Solo un propietario puede borrar la organización' using errcode = '42501';
  end if;
  if coalesce(btrim(p_confirmation), '') <> btrim(v_name) then
    raise exception 'Escribe el nombre exacto de la organización para confirmar el borrado' using errcode = 'RG002';
  end if;

  v_paths := private.delete_organization_data(p_organization_id, p_user_id);
  return jsonb_build_object('organization_id', p_organization_id, 'name', v_name, 'storage_paths', to_jsonb(v_paths));
end $$;

-- Prepara el borrado de una cuenta (solo el servidor, para el usuario del
-- token). Se niega si deja una organización con miembros sin propietario
-- (RG001, con la lista en DETAIL); borra las organizaciones donde es el único
-- miembro y devuelve sus rutas de Storage. La cuenta de Auth la borra después
-- la Edge Function con la API de administración; al borrarla, los disparadores
-- de abajo anonimizan la auditoría.
create function public.gdpr_delete_account_data(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_plan jsonb;
  v_org record;
  v_paths text[] := '{}';
  v_deleted jsonb := '[]'::jsonb;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'La cuenta no existe' using errcode = 'P0001';
  end if;

  v_plan := private.account_deletion_plan(p_user_id);
  if jsonb_array_length(v_plan -> 'blocking') > 0 then
    raise exception 'Antes de borrar la cuenta, traspasa la propiedad o borra las organizaciones donde eres la única persona propietaria'
      using errcode = 'RG001', detail = (v_plan -> 'blocking')::text;
  end if;

  for v_org in
    select (x ->> 'organization_id')::uuid as id, x ->> 'name' as name
    from jsonb_array_elements(v_plan -> 'deleted_with_account') x
  loop
    v_paths := v_paths || private.delete_organization_data(v_org.id, p_user_id);
    v_deleted := v_deleted || jsonb_build_array(jsonb_build_object('organization_id', v_org.id, 'name', v_org.name));
  end loop;

  return jsonb_build_object('deleted_organizations', v_deleted, 'storage_paths', to_jsonb(v_paths));
end $$;

-- Tras borrar los archivos en Storage, el servidor quita sus anotaciones.
create function public.gdpr_forget_storage_paths(p_paths text[])
returns integer
language sql security definer set search_path = '' as $$
  with gone as (
    delete from public.storage_cleanup_queue q where q.storage_path = any (coalesce(p_paths, '{}')) returning 1
  )
  select count(*)::integer from gone;
$$;

-- Sustituye por null los valores de primer nivel que identifican al usuario
-- (su id o su correo). Los datos del registro de auditoría son la fila
-- auditada en plano.
create function private.scrub_user_from_json(p_data jsonb, p_user_id uuid, p_email text)
returns jsonb
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_data) = 'object' then coalesce((
    select jsonb_object_agg(e.key,
      case when e.value = to_jsonb(p_user_id::text)
             or (coalesce(p_email, '') <> '' and jsonb_typeof(e.value) = 'string' and lower(e.value #>> '{}') = lower(p_email))
           then 'null'::jsonb else e.value end)
    from jsonb_each(p_data) e), '{}'::jsonb)
  else p_data end;
$$;

-- Quita del registro de auditoría la autoría de un usuario: su id como autor o
-- como entidad, y su id o su correo dentro de los datos auditados.
create function private.scrub_user_from_audit(p_user_id uuid, p_email text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_id text := p_user_id::text;
  v_email text := lower(coalesce(p_email, ''));
begin
  update public.audit_logs al
  set actor_id = case when al.actor_id = p_user_id then null else al.actor_id end,
      entity_id = case when al.entity_id = v_id then null else al.entity_id end,
      data = private.scrub_user_from_json(al.data, p_user_id, v_email)
  where al.actor_id = p_user_id
     or al.entity_id = v_id
     or strpos(al.data::text, v_id) > 0
     or (v_email <> '' and strpos(lower(al.data::text), v_email) > 0);
end $$;

-- Antes de borrar un usuario:
--   * sale de sus organizaciones y marcas aquí, y no en la cascada, para que
--     los apuntes de auditoría de esas bajas existan ya al limpiar (los de la
--     cascada se escribirían después). Si es la única propietaria de una
--     organización, el disparador `keep_one_owner` lo impide y nada se borra;
--   * anonimiza las invitaciones que aceptó (su correo queda en la invitación);
--   * deja sin dueño sus archivos en Storage;
--   * limpia su autoría del registro de auditoría.
create function private.forget_user_before_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.brand_members bm where bm.user_id = old.id;
  delete from public.organization_members om where om.user_id = old.id;

  update public.invitations i
  set email = 'anonimizada.' || replace(i.id::text, '-', '') || '@borrado.invalid'
  where i.accepted_by = old.id;

  -- `storage.objects.owner` apunta al usuario que subió el archivo. Si el rol
  -- que ejecuta esto no puede tocar Storage, se deja como estaba: el borrado de
  -- la cuenta no debe fallar por ello.
  begin
    update storage.objects o set owner = null where o.owner = old.id;
  exception when insufficient_privilege then
    null;
  end;

  perform private.scrub_user_from_audit(old.id, old.email);
  return old;
end $$;

-- Después de borrar un usuario: otra pasada por lo que hayan escrito las
-- cascadas (autorías puestas a null que la auditoría registra).
create function private.forget_user_after_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform private.scrub_user_from_audit(old.id, old.email);
  return null;
end $$;

create trigger on_auth_user_deleting before delete on auth.users
  for each row execute function private.forget_user_before_delete();
-- «zz»: los disparadores AFTER de una tabla se ejecutan por orden alfabético.
create trigger zz_on_auth_user_deleted after delete on auth.users
  for each row execute function private.forget_user_after_delete();

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.legal_version_valid(text) from public, anon, authenticated;
revoke all on function private.record_signup_legal_acceptance() from public, anon, authenticated;
revoke all on function private.account_deletion_plan(uuid) from public, anon, authenticated;
revoke all on function private.organization_storage_paths(uuid) from public, anon, authenticated;
revoke all on function private.delete_organization_data(uuid, uuid) from public, anon, authenticated;
revoke all on function private.scrub_user_from_json(jsonb, uuid, text) from public, anon, authenticated;
revoke all on function private.scrub_user_from_audit(uuid, text) from public, anon, authenticated;
revoke all on function private.forget_user_before_delete() from public, anon, authenticated;
revoke all on function private.forget_user_after_delete() from public, anon, authenticated;

revoke all on function public.accept_legal_documents(text, text) from public, anon, authenticated;
revoke all on function public.export_my_data() from public, anon, authenticated;
revoke all on function public.export_organization_data(uuid) from public, anon, authenticated;
revoke all on function public.my_account_deletion_check() from public, anon, authenticated;
revoke all on function public.gdpr_delete_organization(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.gdpr_delete_account_data(uuid) from public, anon, authenticated;
revoke all on function public.gdpr_forget_storage_paths(text[]) from public, anon, authenticated;

grant execute on function public.accept_legal_documents(text, text) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.export_organization_data(uuid) to authenticated;
grant execute on function public.my_account_deletion_check() to authenticated;
-- Borrar es cosa del servidor: solo la clave de servicio.
grant execute on function public.gdpr_delete_organization(uuid, uuid, text) to service_role;
grant execute on function public.gdpr_delete_account_data(uuid) to service_role;
grant execute on function public.gdpr_forget_storage_paths(text[]) to service_role;
