-- Fases 3–6 juntas: la protección de datos (20261119410000) alcanza a las
-- tablas que trajeron las otras ramas.
--
-- * «Descargar mis datos» (`export_my_data`) añade lo que escribió o hizo la
--   persona: comentarios de aprobación, campañas que creó, publicaciones que
--   programó, cuentas que conectó (sin tokens), tipografías que subió, sus
--   avisos de encargos y los informes de analítica que pidió.
-- * Exportar la organización (`export_organization_data`) añade el plan
--   contratado y, por marca, tipografías, cuentas conectadas (sin tokens),
--   calendario con sus intentos, comentarios, campañas con sus planes y la
--   analítica (cifras diarias de cuenta y de publicación, capturas e informes;
--   el PDF de cada informe es un recurso de la biblioteca, ya en `assets`).
-- * Las rutas de Storage de la organización incluyen las tipografías.
--
-- El borrado no necesita más: todas las tablas nuevas cuelgan de la marca o de
-- la organización con `on delete cascade` (los tokens cifrados, de su cuenta),
-- las autorías son `on delete set null` y los avisos de una persona, `on
-- delete cascade`; la analítica cuelga de la cuenta conectada o de la marca
-- (`on delete cascade`) y quien pidió un informe queda en `set null`. Lo
-- comprueba tests/db/rgpd.test.ts. Se conservan a
-- propósito, como el libro de consumo de IA, los avisos de Stripe
-- (`billing_events`, sin datos personales): son la base de la facturación.

create or replace function public.export_my_data()
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
      from public.jobs j where j.created_by = v_uid), '[]'::jsonb),
    -- Fases 3–6 (20261119720000): comentarios, campañas, calendario, cuentas
    -- conectadas, tipografías y avisos. Nunca los tokens de las cuentas.
    'content_comments', coalesce((
      select jsonb_agg(jsonb_build_object('content_id', cc.content_id, 'brand_id', cc.brand_id,
                                          'version', cc.version, 'kind', cc.kind, 'body', cc.body,
                                          'created_at', cc.created_at)
                       order by cc.created_at, cc.id)
      from public.content_comments cc where cc.author_id = v_uid), '[]'::jsonb),
    'campaigns_created', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'brand_id', c.brand_id, 'title', c.title,
                                          'instruction', c.instruction, 'networks', c.networks,
                                          'starts_on', c.starts_on, 'ends_on', c.ends_on, 'status', c.status,
                                          'created_at', c.created_at)
                       order by c.created_at)
      from public.campaigns c where c.created_by = v_uid), '[]'::jsonb),
    'publications_scheduled', coalesce((
      select jsonb_agg(jsonb_build_object('id', sp.id, 'brand_id', sp.brand_id, 'content_id', sp.content_id,
                                          'network', sp.network, 'scheduled_at', sp.scheduled_at,
                                          'status', sp.status, 'created_at', sp.created_at)
                       order by sp.created_at)
      from public.scheduled_publications sp where sp.created_by = v_uid), '[]'::jsonb),
    'social_accounts_connected', coalesce((
      select jsonb_agg(jsonb_build_object('brand_id', sa.brand_id, 'network', sa.network,
                                          'username', sa.username, 'status', sa.status,
                                          'connected_at', sa.connected_at, 'disconnected_at', sa.disconnected_at)
                       order by sa.connected_at)
      from public.social_accounts sa where sa.connected_by = v_uid), '[]'::jsonb),
    'brand_fonts_uploaded', coalesce((
      select jsonb_agg(jsonb_build_object('brand_id', bf.brand_id, 'family', bf.family, 'weight', bf.weight,
                                          'style', bf.style, 'file_name', bf.file_name, 'bytes', bf.bytes,
                                          'license_confirmed', bf.license_confirmed, 'created_at', bf.created_at)
                       order by bf.created_at)
      from public.brand_fonts bf where bf.created_by = v_uid), '[]'::jsonb),
    'request_notifications', coalesce((
      select jsonb_agg(jsonb_build_object('request_id', rn.request_id, 'brand_id', rn.brand_id,
                                          'kind', rn.kind, 'created_at', rn.created_at, 'read_at', rn.read_at)
                       order by rn.created_at)
      from public.request_notifications rn where rn.user_id = v_uid), '[]'::jsonb),
    -- Analítica (Fase 5): los informes que pidió a mano.
    'analytics_reports_requested', coalesce((
      select jsonb_agg(jsonb_build_object('id', ar.id, 'brand_id', ar.brand_id,
                                          'period_start', ar.period_start, 'status', ar.status,
                                          'created_at', ar.created_at)
                       order by ar.created_at)
      from public.analytics_reports ar where ar.requested_by = v_uid), '[]'::jsonb)
  );
end $$;

create or replace function public.export_organization_data(p_organization_id uuid)
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
    -- Plan efectivo y suscripción (sin los identificadores de Stripe).
    'subscription', (
      select jsonb_build_object('plan', (private.org_plan(p_organization_id)).code,
                                'plan_name', (private.org_plan(p_organization_id)).name,
                                'assigned_plan', p.code, 'source', s.source, 'status', s.status,
                                'custom_price_micros', s.custom_price_micros,
                                'current_period_end', s.current_period_end,
                                'cancel_at_period_end', s.cancel_at_period_end, 'updated_at', s.updated_at)
      from public.subscriptions s left join public.plans p on p.id = s.plan_id
      where s.organization_id = p_organization_id),
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
            from public.media_assets a where a.brand_id = b.id), '[]'::jsonb),
          -- Fases 3–6 (20261119720000). De las cuentas, nunca los tokens (no
          -- están en esta tabla) ni los errores internos.
          'fonts', coalesce((
            select jsonb_agg(jsonb_build_object('id', f.id, 'family', f.family, 'weight', f.weight,
                                                'style', f.style, 'format', f.format,
                                                'storage_path', f.storage_path, 'file_name', f.file_name,
                                                'mime_type', f.mime_type, 'bytes', f.bytes,
                                                'license_confirmed', f.license_confirmed,
                                                'license_note', f.license_note, 'created_by', f.created_by,
                                                'created_at', f.created_at)
                             order by f.created_at)
            from public.brand_fonts f where f.brand_id = b.id), '[]'::jsonb),
          'social_accounts', coalesce((
            select jsonb_agg(jsonb_build_object('id', sa.id, 'network', sa.network,
                                                'external_id', sa.external_id, 'username', sa.username,
                                                'display_name', sa.display_name, 'status', sa.status,
                                                'scopes', sa.scopes, 'connected_by', sa.connected_by,
                                                'connected_at', sa.connected_at,
                                                'disconnected_at', sa.disconnected_at)
                             order by sa.connected_at)
            from public.social_accounts sa where sa.brand_id = b.id), '[]'::jsonb),
          'publications', coalesce((
            select jsonb_agg((to_jsonb(sp) - 'locked_by' - 'locked_until') || jsonb_build_object(
                               'attempts', coalesce((
                                 select jsonb_agg(to_jsonb(pa) order by pa.attempt_no, pa.id)
                                 from public.publication_attempts pa where pa.publication_id = sp.id), '[]'::jsonb))
                             order by sp.scheduled_at, sp.id)
            from public.scheduled_publications sp where sp.brand_id = b.id), '[]'::jsonb),
          'content_comments', coalesce((
            select jsonb_agg(jsonb_build_object('content_id', cc.content_id, 'version', cc.version,
                                                'kind', cc.kind, 'body', cc.body, 'author_id', cc.author_id,
                                                'created_at', cc.created_at)
                             order by cc.created_at, cc.id)
            from public.content_comments cc where cc.brand_id = b.id), '[]'::jsonb),
          'campaigns', coalesce((
            select jsonb_agg(to_jsonb(c) || jsonb_build_object(
                               'plans', coalesce((
                                 select jsonb_agg(jsonb_build_object('version', cp.version, 'source', cp.source,
                                                                     'data', cp.data, 'created_by', cp.created_by,
                                                                     'created_at', cp.created_at)
                                                  order by cp.version)
                                 from public.campaign_plans cp where cp.campaign_id = c.id), '[]'::jsonb),
                               'contents', coalesce((
                                 select jsonb_agg(jsonb_build_object('content_id', ct.content_id,
                                                                     'plan_version', ct.plan_version,
                                                                     'piece_index', ct.piece_index)
                                                  order by ct.plan_version, ct.piece_index)
                                 from public.campaign_contents ct where ct.campaign_id = c.id), '[]'::jsonb))
                             order by c.created_at)
            from public.campaigns c where c.brand_id = b.id), '[]'::jsonb),
          -- Analítica (Fase 5): cifras medidas, capturas e informes.
          'analytics', jsonb_build_object(
            'account_metrics', coalesce((
              select jsonb_agg(jsonb_build_object('social_account_id', m.social_account_id,
                                                  'metric_id', m.metric_id, 'date', m.metric_date,
                                                  'value', m.value, 'provisional', m.provisional,
                                                  'captured_at', m.captured_at)
                               order by m.metric_date, m.metric_id, m.social_account_id)
              from public.account_metrics_daily m where m.brand_id = b.id), '[]'::jsonb),
            'media_metrics', coalesce((
              select jsonb_agg(jsonb_build_object('social_account_id', m.social_account_id,
                                                  'publication_id', m.publication_id,
                                                  'external_media_id', m.external_media_id,
                                                  'media_product_type', m.media_product_type,
                                                  'published_at', m.published_at, 'metric_id', m.metric_id,
                                                  'date', m.metric_date, 'value', m.value,
                                                  'provisional', m.provisional, 'captured_at', m.captured_at)
                               order by m.metric_date, m.external_media_id, m.metric_id)
              from public.media_metrics_daily m where m.brand_id = b.id), '[]'::jsonb),
            'captures', coalesce((
              select jsonb_agg(jsonb_build_object('social_account_id', cr.social_account_id,
                                                  'status', cr.status, 'window_from', cr.window_from,
                                                  'window_to', cr.window_to, 'unavailable', cr.unavailable,
                                                  'error_code', cr.error_code, 'started_at', cr.started_at,
                                                  'finished_at', cr.finished_at)
                               order by cr.started_at, cr.id)
              from public.analytics_capture_runs cr where cr.brand_id = b.id), '[]'::jsonb),
            'reports', coalesce((
              select jsonb_agg(jsonb_build_object('id', ar.id, 'period_start', ar.period_start,
                                                  'status', ar.status, 'source', ar.source,
                                                  'revision', ar.revision, 'media_asset_id', ar.media_asset_id,
                                                  'summary', ar.summary, 'requested_by', ar.requested_by,
                                                  'generated_at', ar.generated_at, 'created_at', ar.created_at)
                               order by ar.period_start)
              from public.analytics_reports ar where ar.brand_id = b.id), '[]'::jsonb)
          )
        )
        order by b.created_at)
      from public.brands b where b.organization_id = p_organization_id), '[]'::jsonb)
  );
end $$;

create or replace function private.organization_storage_paths(p_organization_id uuid)
returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct p order by p), '{}'::text[])
  from (
    select a.storage_path as p from public.media_assets a where a.organization_id = p_organization_id
    union all
    select s.storage_path from public.brand_knowledge_sources s
    where s.organization_id = p_organization_id and s.storage_path is not null
    union all
    select f.storage_path from public.brand_fonts f where f.organization_id = p_organization_id
    union all
    select q.storage_path from public.storage_cleanup_queue q where q.organization_id = p_organization_id
    union all
    select o.name from storage.objects o
    where o.bucket_id = 'brand-media' and o.name like p_organization_id::text || '/%'
  ) paths;
$$;
