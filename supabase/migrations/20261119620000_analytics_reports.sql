-- Fase 5 · Analítica: informe mensual en PDF por marca (docs/analitica.md).
--
-- Circuito, sin intervención de nadie:
--   1. El reloj (migración 20261119630000) encola, a partir del día 3 de cada
--      mes, un trabajo `analytics.report` por marca con alguna cuenta social
--      para el mes anterior (se espera al día 3 porque Meta corrige las cifras
--      hasta 48 h después). Quien edita la marca también puede pedirlo
--      (`request_analytics_report`).
--   2. La Edge Function `social-insights` lo atiende: lee las cifras con
--      `analytics_report_source`, redacta el resumen (dato frente a hipótesis,
--      con reglas, sin IA) y deja el documento listo con
--      `analytics_report_render`, que encola `media.report.pdf` con la ruta de
--      salida fijada AQUÍ (dentro de la marca, nombre nuevo).
--   3. El trabajador de medios (worker/) dibuja el PDF y lo sube. Al
--      completarse el trabajo, un disparador lo da de alta en la biblioteca
--      (`media_assets`, carpeta «Informes», procedencia `analytics_report`, que
--      solo puede poner la base de datos) y marca el informe como listo; o
--      como fallido si el trabajo falla del todo.

create table public.analytics_reports (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Primer día del mes del informe.
  period_start date not null check (extract(day from period_start) = 1),
  -- queued: preparando las cifras · rendering: dibujando el PDF · ready · failed.
  status text not null default 'queued' check (status in ('queued', 'rendering', 'ready', 'failed')),
  -- schedule: lo pidió el reloj · manual: lo pidió una persona.
  source text not null check (source in ('schedule', 'manual')),
  -- Sube cada vez que se vuelve a generar.
  revision integer not null default 1 check (revision > 0),
  data_job_id uuid,
  render_job_id uuid,
  media_asset_id uuid references public.media_assets (id) on delete set null,
  -- Resumen que acompaña al informe (datos, hipótesis y lo que no se puede medir).
  summary jsonb not null default '{}'::jsonb
    check (jsonb_typeof(summary) = 'object' and pg_column_size(summary) <= 65536),
  error text check (error is null or char_length(error) <= 1000),
  requested_by uuid references auth.users (id) on delete set null,
  generated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  unique (brand_id, period_start)
);
create index analytics_reports_brand_idx on public.analytics_reports (brand_id, period_start desc);

create trigger analytics_reports_touch before update on public.analytics_reports
  for each row execute function private.touch_updated_at();

-- ─────────────────────── Procedencia en la biblioteca ───────────────────────

-- Un informe en la biblioteca lleva `provenance.type` = 'analytics_report'.
-- Solo lo pone la base de datos: nadie sube un PDF haciéndolo pasar por un informe.
create function private.media_assets_guard_report_provenance() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.provenance ->> 'type' = 'analytics_report' and current_user in ('authenticated', 'anon') then
    raise exception 'La procedencia de un informe solo la pone la base de datos' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger media_assets_guard_report_provenance before insert on public.media_assets
  for each row execute function private.media_assets_guard_report_provenance();

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Encola (o vuelve a encolar) el informe de una marca y un mes. Si ya se está
-- preparando, devuelve el que hay: no se duplica.
create function private.analytics_report_enqueue(
  p_brand_id uuid, p_period_start date, p_source text, p_user uuid
) returns public.analytics_reports
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_report public.analytics_reports;
  v_job public.jobs;
begin
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id for update;
  if v_org is null then
    raise exception 'La marca no existe' using errcode = 'P0001';
  end if;
  select * into v_report from public.analytics_reports r
  where r.brand_id = p_brand_id and r.period_start = p_period_start for update;
  if found and v_report.status in ('queued', 'rendering') then
    return v_report;
  end if;
  if found then
    update public.analytics_reports r
    set status = 'queued', revision = r.revision + 1, source = p_source, error = null, data_job_id = null,
        render_job_id = null, requested_by = p_user
    where r.id = v_report.id
    returning * into v_report;
  else
    insert into public.analytics_reports (brand_id, organization_id, period_start, source, requested_by)
    values (p_brand_id, v_org, p_period_start, p_source, p_user)
    returning * into v_report;
  end if;
  v_job := public.enqueue_job(
    v_org, 'analytics.report',
    jsonb_build_object('report_id', v_report.id, 'revision', v_report.revision),
    'analytics.report:' || v_report.id || ':' || v_report.revision,
    p_brand_id, -5, 3, null, p_user);
  update public.analytics_reports r set data_job_id = v_job.id where r.id = v_report.id returning * into v_report;
  return v_report;
end $$;

-- ─────────────────────────── RPC para personas ───────────────────────────

-- Pide (o vuelve a pedir) el informe de un mes ya terminado. Quien edita la marca.
create function public.request_analytics_report(p_brand_id uuid, p_period_start date)
returns public.analytics_reports
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Inicia sesión para pedir informes' using errcode = '42501';
  end if;
  if p_brand_id is null or p_brand_id not in (select private.brand_ids_with('edit')) then
    raise exception 'Solo quien edita la marca puede pedir sus informes' using errcode = '42501';
  end if;
  if p_period_start is null or extract(day from p_period_start) <> 1
     or p_period_start >= date_trunc('month', now() at time zone 'UTC')::date
     or p_period_start < (date_trunc('month', now() at time zone 'UTC') - interval '24 months')::date then
    raise exception 'Elige un mes ya terminado de los dos últimos años' using errcode = '22023';
  end if;
  return private.analytics_report_enqueue(p_brand_id, p_period_start, 'manual', (select auth.uid()));
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Encola el informe del mes indicado (por defecto, el anterior) para cada
-- marca con alguna cuenta social que aún no lo tenga. Devuelve cuántos.
create function public.analytics_enqueue_monthly_reports(p_period_start date default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_period date := coalesce(p_period_start,
                            (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date);
  v_brand uuid;
  v_count integer := 0;
begin
  if extract(day from v_period) <> 1 then
    raise exception 'El periodo empieza el día 1' using errcode = '22023';
  end if;
  for v_brand in
    select distinct a.brand_id from public.social_accounts a
    join public.brands b on b.id = a.brand_id
    where a.connected_at < (v_period + interval '1 month')
      and not exists (select 1 from public.analytics_reports r where r.brand_id = a.brand_id and r.period_start = v_period)
  loop
    perform private.analytics_report_enqueue(v_brand, v_period, 'schedule', null);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Todo lo que hace falta para redactar el informe de un mes: la marca, su
-- identidad visual (colores y el primer logotipo PNG o JPEG del perfil), las
-- cuentas, el catálogo de métricas, las series del mes y del anterior, las
-- publicaciones del mes con su última cifra y lo que no se pudo medir.
create function public.analytics_report_source(p_report_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_report public.analytics_reports;
  v_from date;
  v_to date;
  v_prev date;
  v_profile jsonb;
  v_logo jsonb;
begin
  select * into v_report from public.analytics_reports r where r.id = p_report_id;
  if not found then
    raise exception 'El informe no existe' using errcode = 'P0001';
  end if;
  v_from := v_report.period_start;
  v_to := (v_from + interval '1 month')::date;
  v_prev := (v_from - interval '1 month')::date;
  select p.data into v_profile from public.brand_profiles p where p.brand_id = v_report.brand_id and p.status = 'active';
  select jsonb_build_object('path', a.storage_path, 'mime_type', a.mime_type) into v_logo
  from jsonb_array_elements_text(coalesce(v_profile #> '{visual,logoAssetIds}', '[]'::jsonb)) with ordinality l(id, ord)
  join public.media_assets a on a.id::text = l.id and a.brand_id = v_report.brand_id
  where a.mime_type in ('image/png', 'image/jpeg')
  order by l.ord limit 1;

  return jsonb_build_object(
    'report', jsonb_build_object('id', v_report.id, 'revision', v_report.revision, 'status', v_report.status,
                                 'source', v_report.source),
    'brand', (select jsonb_build_object('id', b.id, 'name', b.name, 'timezone', b.timezone) from public.brands b
              where b.id = v_report.brand_id),
    'period', jsonb_build_object('start', v_from, 'end', v_to, 'previous_start', v_prev),
    'visual', jsonb_build_object('colors', coalesce(v_profile #> '{visual,colors}', '[]'::jsonb), 'logo', v_logo),
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'network', a.network, 'username', a.username,
                                                             'status', a.status) order by a.created_at)
                          from public.social_accounts a where a.brand_id = v_report.brand_id), '[]'::jsonb),
    'definitions', (select jsonb_agg(to_jsonb(d) order by d.sort) from public.analytics_metric_definitions d),
    'account_metrics', coalesce((
      select jsonb_agg(jsonb_build_object('account_id', m.social_account_id, 'metric_id', m.metric_id,
                                          'date', m.metric_date, 'value', m.value, 'provisional', m.provisional)
                       order by m.metric_date, m.metric_id)
      from public.account_metrics_daily m
      where m.brand_id = v_report.brand_id and m.metric_date >= v_prev and m.metric_date < v_to), '[]'::jsonb),
    'media', coalesce((
      select jsonb_agg(x order by x ->> 'published_at') from (
        select jsonb_build_object(
                 'publication_id', l.publication_id, 'external_media_id', l.external_media_id,
                 'title', coalesce(c.title, '(pieza borrada)'), 'format', coalesce(p.format, ''),
                 'network', coalesce(p.network, 'instagram'), 'media_product_type', l.media_product_type,
                 'published_at', min(l.published_at), 'external_url', p.external_url,
                 'provisional', bool_or(l.provisional), 'metrics', jsonb_object_agg(l.metric_id, l.value)) as x
        from (
          select distinct on (m.external_media_id, m.metric_id) m.*
          from public.media_metrics_daily m
          where m.brand_id = v_report.brand_id and m.published_at >= v_prev and m.published_at < v_to
            -- La cifra a fin de mes (o la última anterior), no la de hoy.
            and m.metric_date < (v_to + 3)
          order by m.external_media_id, m.metric_id, m.metric_date desc
        ) l
        left join public.scheduled_publications p on p.id = l.publication_id
        left join public.content_items c on c.id = p.content_id
        group by l.publication_id, l.external_media_id, c.title, p.format, p.network, l.media_product_type,
                 p.external_url
      ) s), '[]'::jsonb),
    'unavailable', coalesce((
      select jsonb_agg(jsonb_build_object('metric_id', u.metric_id, 'reason', u.reason, 'message', u.message,
                                          'times', u.times))
      from (
        select e.value ->> 'metric_id' as metric_id, e.value ->> 'reason' as reason,
               max(e.value ->> 'message') as message, count(*) as times
        from public.analytics_capture_runs r
        cross join jsonb_array_elements(r.unavailable) e
        where r.brand_id = v_report.brand_id and r.started_at >= v_from and r.started_at < v_to + 3
        group by 1, 2
      ) u), '[]'::jsonb),
    'capture_errors', coalesce((
      select jsonb_agg(jsonb_build_object('error_code', r.error_code, 'message', r.error_message, 'times', r.times))
      from (select r.error_code, max(r.error_message) as error_message, count(*) as times
            from public.analytics_capture_runs r
            where r.brand_id = v_report.brand_id and r.started_at >= v_from and r.started_at < v_to + 3
              and r.error_code is not null
            group by r.error_code) r), '[]'::jsonb)
  );
end $$;

-- Deja el informe listo para dibujar: guarda el resumen y encola el PDF para
-- el trabajador de medios. La ruta de salida y el logotipo los pone la base
-- de datos (el logotipo sale del perfil de la marca, no de quien llama).
create function public.analytics_report_render(p_report_id uuid, p_job_id uuid, p_document jsonb, p_summary jsonb)
returns public.analytics_reports
language plpgsql security definer set search_path = '' as $$
declare
  v_report public.analytics_reports;
  v_job public.jobs;
  v_source jsonb;
begin
  select * into v_report from public.analytics_reports r where r.id = p_report_id for update;
  if not found or v_report.status <> 'queued' or v_report.data_job_id is distinct from p_job_id then
    raise exception 'El informe no está esperando a este trabajo' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_document) is distinct from 'object' or pg_column_size(p_document) > 200000 then
    raise exception 'El documento del informe no es válido' using errcode = '22023';
  end if;
  v_source := public.analytics_report_source(p_report_id);
  v_job := public.enqueue_job(
    v_report.organization_id, 'media.report.pdf',
    jsonb_build_object(
      'report_id', v_report.id,
      'revision', v_report.revision,
      'document', p_document,
      'logo', v_source #> '{visual,logo}',
      'output', jsonb_build_object('path', format('%s/%s/informes/%s.pdf', v_report.organization_id, v_report.brand_id,
                                                  gen_random_uuid()))
    ),
    'media.report.pdf:' || v_report.id || ':' || v_report.revision,
    v_report.brand_id, -5, 3, null, v_report.requested_by);
  update public.analytics_reports r
  set status = 'rendering', render_job_id = v_job.id,
      summary = case when jsonb_typeof(p_summary) = 'object' and pg_column_size(p_summary) <= 65536
                     then p_summary else '{}'::jsonb end
  where r.id = v_report.id
  returning * into v_report;
  return v_report;
end $$;

-- ─────────────────── Resultado a la biblioteca (al completar) ───────────────────

create function private.jobs_publish_analytics_report() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_report public.analytics_reports;
  v_path text := new.payload #>> '{output,path}';
  v_out jsonb := new.result -> 'output';
  v_asset uuid;
begin
  if v_path is null then
    return new;
  end if;
  if jsonb_typeof(v_out) is distinct from 'object' or v_out ->> 'path' is distinct from v_path then
    raise exception 'El resultado del informe no corresponde a su encargo' using errcode = '22023';
  end if;
  select * into v_report from public.analytics_reports r where r.id = (new.payload ->> 'report_id')::uuid for update;

  insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type, bytes,
                                   folder, created_by, provenance)
  values (
    new.brand_id, new.organization_id, 'document', 'generated', v_path,
    format('informe-%s.pdf', to_char(coalesce(v_report.period_start, now()::date), 'YYYY-MM')),
    'application/pdf', (v_out ->> 'bytes')::bigint, 'Informes', new.created_by,
    jsonb_strip_nulls(jsonb_build_object(
      'type', 'analytics_report',
      'report_id', new.payload ->> 'report_id',
      'revision', (new.payload ->> 'revision')::integer,
      'period', to_char(v_report.period_start, 'YYYY-MM'),
      'source', v_report.source,
      'job_id', new.id,
      'pages', (v_out ->> 'pages')::integer
    ))
  )
  on conflict (storage_path) do nothing
  returning id into v_asset;
  if v_asset is null then
    select a.id into v_asset from public.media_assets a where a.storage_path = v_path;
  end if;

  -- Solo el último encargo del informe lo da por listo (uno viejo deja su PDF en la biblioteca y nada más).
  if v_report.id is not null and v_report.render_job_id = new.id then
    update public.analytics_reports r
    set status = 'ready', media_asset_id = v_asset, generated_at = now(), error = null
    where r.id = v_report.id;
  end if;
  new.result := coalesce(new.result, '{}'::jsonb)
    || jsonb_build_object('assets', jsonb_build_array(jsonb_build_object('id', v_asset, 'path', v_path, 'kind', 'document')));
  return new;
end $$;

create trigger jobs_publish_analytics_report before update of status on public.jobs
  for each row
  when (new.status = 'succeeded' and old.status is distinct from new.status and new.brand_id is not null
        and new.kind = 'media.report.pdf')
  execute function private.jobs_publish_analytics_report();

-- Si el trabajo de las cifras o el del PDF falla del todo (o se cancela), el informe queda fallido.
create function private.jobs_fail_analytics_report() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.analytics_reports r
  set status = 'failed', error = left(coalesce(new.last_error, 'El trabajo se canceló'), 1000)
  where r.id = (new.payload ->> 'report_id')::uuid
    and r.status in ('queued', 'rendering')
    and (r.data_job_id = new.id or r.render_job_id = new.id);
  return null;
end $$;

create trigger jobs_fail_analytics_report after update of status on public.jobs
  for each row
  when (new.status in ('failed', 'cancelled') and old.status is distinct from new.status
        and new.kind in ('analytics.report', 'media.report.pdf'))
  execute function private.jobs_fail_analytics_report();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.analytics_reports enable row level security;

create policy analytics_reports_select on public.analytics_reports for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on public.analytics_reports from public, anon, authenticated;
grant select on public.analytics_reports to authenticated, service_role;

revoke all on function private.media_assets_guard_report_provenance() from public, anon, authenticated;
revoke all on function private.analytics_report_enqueue(uuid, date, text, uuid) from public, anon, authenticated;
revoke all on function private.jobs_publish_analytics_report() from public, anon, authenticated;
revoke all on function private.jobs_fail_analytics_report() from public, anon, authenticated;
revoke all on function public.request_analytics_report(uuid, date) from public, anon, authenticated;
revoke all on function public.analytics_enqueue_monthly_reports(date) from public, anon, authenticated;
revoke all on function public.analytics_report_source(uuid) from public, anon, authenticated;
revoke all on function public.analytics_report_render(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;

grant execute on function public.request_analytics_report(uuid, date) to authenticated;
grant execute on function public.analytics_enqueue_monthly_reports(date) to service_role;
grant execute on function public.analytics_report_source(uuid) to service_role;
grant execute on function public.analytics_report_render(uuid, uuid, jsonb, jsonb) to service_role;
