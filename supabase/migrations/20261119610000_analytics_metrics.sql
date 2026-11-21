-- Fase 5 · Analítica: métricas capturadas de las redes (docs/analitica.md).
--
--   * `analytics_metric_definitions` es el catálogo de métricas: qué mide cada
--     una, cómo se llama en la API, de dónde sale, si la red la estima, cuánto
--     retraso tiene y si hoy se captura, no se captura o la red la retiró. Es
--     de la plataforma (no de un cliente) y se escribe solo con migraciones:
--     cada cifra guardada apunta a su definición.
--   * `account_metrics_daily`: una fila por cuenta, métrica y día (UTC). Volver
--     a capturar el mismo día ACTUALIZA la fila (la red corrige sus cifras
--     hasta 48 h después): nunca hay dos filas para lo mismo. Guarda cuándo se
--     capturó por primera y por última vez, cuántas veces, y si la cifra es
--     todavía provisional (dentro del retraso que anuncia la red).
--   * `media_metrics_daily`: lo mismo para cada publicación hecha por la
--     plataforma; el valor es el acumulado de la publicación el día de la
--     captura (las métricas de una publicación son de toda su vida).
--   * `analytics_capture_runs`: cada pasada del capturador por una cuenta, con
--     lo que no se pudo medir y por qué (es lo que enseña «lo que no se puede
--     medir»).
--   * Nadie escribe estas tablas a mano: el capturador (Edge Function
--     `social-insights`, clave de servicio) usa `analytics_capture_begin` y
--     `analytics_record_capture`, que validan todo. Las personas ven las cifras
--     de las marcas que ven.

-- ───────────────────────────── Catálogo ─────────────────────────────

create table public.analytics_metric_definitions (
  -- «red.ámbito.métrica», p. ej. instagram.account.reach.
  id text primary key check (id ~ '^[a-z]+\.(account|media)\.[a-z0-9_]{1,60}$'),
  network text not null check (network in ('instagram', 'facebook')),
  scope text not null check (scope in ('account', 'media')),
  -- Nombre en la API (métrica de insights o campo del nodo); null si no se pide.
  api_name text check (api_name is null or api_name ~ '^[a-z0-9_]{1,80}$'),
  api_source text check (api_source in ('insights', 'field')),
  label text not null check (char_length(label) between 1 and 80),
  description text not null check (char_length(description) between 1 and 600),
  unit text not null default 'count' check (unit in ('count', 'milliseconds')),
  -- daily: cifra de un día · snapshot: valor en el momento de la captura ·
  -- lifetime: acumulado de una publicación desde que salió.
  aggregation text not null check (aggregation in ('daily', 'snapshot', 'lifetime')),
  -- Tipos de publicación a los que se aplica (FEED, REELS); vacío en la cuenta.
  media_types text[] not null default '{}',
  estimated boolean not null default false,
  in_development boolean not null default false,
  -- captured: se captura · not_captured: existe pero no se captura (y por qué) ·
  -- retired: la red la retiró.
  status text not null check (status in ('captured', 'not_captured', 'retired')),
  status_note text not null default '' check (char_length(status_note) <= 600),
  -- Retraso máximo que anuncia la red antes de dar la cifra por buena.
  delay_hours integer not null default 48 check (delay_hours between 0 and 720),
  source_url text not null check (source_url ~ '^https://'),
  verified_on date not null,
  sort integer not null default 100,
  check ((status = 'captured') = (api_name is not null and api_source is not null))
);

insert into public.analytics_metric_definitions
  (id, network, scope, api_name, api_source, label, description, unit, aggregation, media_types, estimated,
   in_development, status, status_note, delay_hours, source_url, verified_on, sort)
values
  -- Cuenta de Instagram.
  ('instagram.account.followers', 'instagram', 'account', 'followers_count', 'field', 'Seguidores',
   'Número de seguidores de la cuenta en el momento de la captura (campo followers_count de la cuenta). La API no da el histórico: la serie empieza el día en que se conecta la cuenta.',
   'count', 'snapshot', '{}', false, false, 'captured', '', 0,
   'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user', '2026-11-18', 10),
  ('instagram.account.reach', 'instagram', 'account', 'reach', 'insights', 'Alcance',
   'Cuentas únicas que vieron el contenido de la cuenta ese día. Es una estimación de Meta.',
   'count', 'daily', '{}', true, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 20),
  ('instagram.account.views', 'instagram', 'account', 'views', 'insights', 'Visualizaciones',
   'Veces que se vio o reprodujo el contenido de la cuenta ese día. Sustituye a «impresiones», pero no es la misma medida. Meta la marca «en desarrollo».',
   'count', 'daily', '{}', false, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 30),
  ('instagram.account.accounts_engaged', 'instagram', 'account', 'accounts_engaged', 'insights', 'Cuentas que interactuaron',
   'Cuentas que interactuaron con el contenido ese día. Es una estimación de Meta.',
   'count', 'daily', '{}', true, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 40),
  ('instagram.account.total_interactions', 'instagram', 'account', 'total_interactions', 'insights', 'Interacciones',
   'Me gusta, guardados, comentarios y compartidos de ese día, descontando los que se retiraron.',
   'count', 'daily', '{}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 50),
  ('instagram.account.likes', 'instagram', 'account', 'likes', 'insights', 'Me gusta',
   'Me gusta recibidos ese día.', 'count', 'daily', '{}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 60),
  ('instagram.account.comments', 'instagram', 'account', 'comments', 'insights', 'Comentarios',
   'Comentarios recibidos ese día. Meta la marca «en desarrollo».', 'count', 'daily', '{}', false, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 70),
  ('instagram.account.saves', 'instagram', 'account', 'saves', 'insights', 'Guardados',
   'Veces que se guardó el contenido de la cuenta ese día.', 'count', 'daily', '{}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 80),
  ('instagram.account.shares', 'instagram', 'account', 'shares', 'insights', 'Compartidos',
   'Veces que se compartió el contenido de la cuenta ese día.', 'count', 'daily', '{}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 90),
  ('instagram.account.profile_links_taps', 'instagram', 'account', 'profile_links_taps', 'insights', 'Toques en los enlaces del perfil',
   'Toques en los botones de contacto y enlaces del perfil ese día.', 'count', 'daily', '{}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 100),
  ('instagram.account.follows_and_unfollows', 'instagram', 'account', null, null, 'Nuevos seguidores y bajas',
   'Cuentas que empezaron o dejaron de seguir a la cuenta.', 'count', 'daily', '{}', false, false, 'not_captured',
   'No se captura todavía: Meta no la devuelve a cuentas con menos de 100 seguidores y el desglose (follow_type) está sin comprobar con una cuenta real. Mientras tanto se ve la evolución de «Seguidores».',
   48, 'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 110),
  ('instagram.account.follower_demographics', 'instagram', 'account', null, null, 'Datos demográficos de la audiencia',
   'Edad, ciudad, país y género de los seguidores.', 'count', 'snapshot', '{}', false, false, 'not_captured',
   'No se captura en esta versión. Meta solo la da a cuentas con 100 seguidores o más, por periodos fijos y con los 45 primeros valores.',
   48, 'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 120),
  ('instagram.account.impressions', 'instagram', 'account', null, null, 'Impresiones',
   'Veces que se mostró el contenido.', 'count', 'daily', '{}', false, false, 'retired',
   'Meta la retiró para todas las versiones de la API el 21/04/2025. «Visualizaciones» la sustituye, pero no son comparables.',
   48, 'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 130),
  ('instagram.account.profile_views', 'instagram', 'account', null, null, 'Visitas al perfil',
   'Veces que se visitó el perfil.', 'count', 'daily', '{}', false, false, 'not_captured',
   'No figura entre las métricas de cuenta de la documentación vigente de Meta: no se puede medir por la API.',
   48, 'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 140),
  -- Publicaciones de Instagram (las hechas por la plataforma).
  ('instagram.media.reach', 'instagram', 'media', 'reach', 'insights', 'Alcance',
   'Cuentas únicas que vieron la publicación desde que salió. Es una estimación de Meta.',
   'count', 'lifetime', '{FEED,REELS}', true, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 210),
  ('instagram.media.views', 'instagram', 'media', 'views', 'insights', 'Visualizaciones',
   'Veces que se vio la publicación; en un reel, sus reproducciones. Meta la marca «en desarrollo». Solo orgánico: no cuenta los anuncios.',
   'count', 'lifetime', '{FEED,REELS}', false, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 220),
  ('instagram.media.likes', 'instagram', 'media', 'likes', 'insights', 'Me gusta',
   'Me gusta de la publicación (solo orgánicos).', 'count', 'lifetime', '{FEED,REELS}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 230),
  ('instagram.media.comments', 'instagram', 'media', 'comments', 'insights', 'Comentarios',
   'Comentarios de la publicación (solo orgánicos).', 'count', 'lifetime', '{FEED,REELS}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 240),
  ('instagram.media.saved', 'instagram', 'media', 'saved', 'insights', 'Guardados',
   'Veces que se guardó la publicación.', 'count', 'lifetime', '{FEED,REELS}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 250),
  ('instagram.media.shares', 'instagram', 'media', 'shares', 'insights', 'Compartidos',
   'Veces que se compartió la publicación.', 'count', 'lifetime', '{FEED,REELS}', false, false, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 260),
  ('instagram.media.total_interactions', 'instagram', 'media', 'total_interactions', 'insights', 'Interacciones',
   'Me gusta, guardados, comentarios y compartidos, descontando los retirados. Meta la marca «en desarrollo».',
   'count', 'lifetime', '{FEED,REELS}', false, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 270),
  ('instagram.media.ig_reels_avg_watch_time', 'instagram', 'media', 'ig_reels_avg_watch_time', 'insights',
   'Tiempo medio de reproducción',
   'Tiempo medio que se reprodujo el reel. Es una estimación de Meta. Unidad: milisegundos según la documentación, sin comprobar con una cuenta real.',
   'milliseconds', 'lifetime', '{REELS}', true, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 280),
  ('instagram.media.ig_reels_video_view_total_time', 'instagram', 'media', 'ig_reels_video_view_total_time', 'insights',
   'Tiempo total de reproducción',
   'Tiempo total que se reprodujo el reel, con repeticiones. Meta la marca «en desarrollo». Unidad: milisegundos según la documentación, sin comprobar con una cuenta real.',
   'milliseconds', 'lifetime', '{REELS}', false, true, 'captured', '', 48,
   'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 290),
  ('instagram.media.impressions', 'instagram', 'media', null, null, 'Impresiones',
   'Veces que se mostró la publicación.', 'count', 'lifetime', '{FEED}', false, false, 'retired',
   'Meta la retiró para las publicaciones creadas desde el 02/07/2024: no existe para lo publicado con la plataforma.',
   48, 'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 300),
  ('instagram.media.video_views', 'instagram', 'media', null, null, 'Reproducciones (antigua)',
   'Reproducciones de vídeo con la medida antigua.', 'count', 'lifetime', '{REELS}', false, false, 'retired',
   'Retirada por Meta (una página antigua de su documentación da el 08/01/2025). Las reproducciones de un reel se miden con «Visualizaciones».',
   48, 'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 310),
  ('instagram.media.story_metrics', 'instagram', 'media', null, null, 'Métricas de historias',
   'Alcance, respuestas y navegación de las historias.', 'count', 'lifetime', '{STORY}', false, false, 'not_captured',
   'La plataforma no publica historias, y Meta solo da sus métricas durante 24 horas.',
   48, 'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 320),
  ('instagram.media.carousel_items', 'instagram', 'media', null, null, 'Métricas de cada imagen de un carrusel',
   'Cifras por separado de cada imagen de un carrusel.', 'count', 'lifetime', '{FEED}', false, false, 'not_captured',
   'Meta no da métricas de las piezas de un carrusel: solo del carrusel entero.',
   48, 'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights/', '2026-11-18', 330),
  -- Facebook.
  ('facebook.account.all', 'facebook', 'account', null, null, 'Facebook',
   'Métricas de las páginas de Facebook.', 'count', 'daily', '{}', false, false, 'not_captured',
   'Las páginas de Facebook todavía no se conectan: no hay cifras de Facebook que comparar.',
   48, 'https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights', '2026-11-18', 900);

-- ───────────────────────────── Series ─────────────────────────────

create table public.account_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  metric_id text not null references public.analytics_metric_definitions (id),
  -- Día al que se refiere la cifra (UTC). En una métrica «snapshot», el día de la captura.
  metric_date date not null,
  value numeric not null check (value >= 0 and value < 1e15),
  first_captured_at timestamptz not null default now(),
  captured_at timestamptz not null default now(),
  capture_count integer not null default 1 check (capture_count > 0),
  -- Todavía dentro del retraso que anuncia la red: la cifra puede cambiar.
  provisional boolean not null default false,
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id) on delete cascade,
  unique (social_account_id, metric_id, metric_date)
);
create index account_metrics_daily_brand_idx on public.account_metrics_daily (brand_id, metric_date);

create table public.media_metrics_daily (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  -- Publicación de la plataforma (se conserva la cifra aunque se borre la pieza).
  publication_id uuid references public.scheduled_publications (id) on delete set null,
  external_media_id text not null check (char_length(external_media_id) between 1 and 100),
  -- FEED (imagen o carrusel) o REELS, como lo llama la API.
  media_product_type text not null check (media_product_type in ('FEED', 'REELS')),
  published_at timestamptz,
  metric_id text not null references public.analytics_metric_definitions (id),
  -- Día de la captura (UTC): el valor es el acumulado de la publicación ese día.
  metric_date date not null,
  value numeric not null check (value >= 0 and value < 1e15),
  first_captured_at timestamptz not null default now(),
  captured_at timestamptz not null default now(),
  capture_count integer not null default 1 check (capture_count > 0),
  provisional boolean not null default false,
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id) on delete cascade,
  unique (social_account_id, external_media_id, metric_id, metric_date)
);
create index media_metrics_daily_brand_idx on public.media_metrics_daily (brand_id, metric_date);
create index media_metrics_daily_publication_idx on public.media_metrics_daily (publication_id);

create table public.analytics_capture_runs (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  job_id uuid,
  -- succeeded: todo lo pedido · partial: se guardó una parte (límite de la API,
  -- métricas que la red no dio) · failed: nada (token, error) · skipped: la
  -- cuenta no se puede medir (desconectada, red sin capturador).
  status text not null check (status in ('succeeded', 'partial', 'failed', 'skipped')),
  window_from date,
  window_to date,
  api_calls integer not null default 0 check (api_calls >= 0),
  account_rows integer not null default 0 check (account_rows >= 0),
  media_rows integer not null default 0 check (media_rows >= 0),
  -- Lo que no se pudo medir: [{"metric_id": "…", "reason": "no_data|unsupported|permission|…", "message": "…"}]
  unavailable jsonb not null default '[]'::jsonb
    check (jsonb_typeof(unavailable) = 'array' and pg_column_size(unavailable) <= 32768),
  error_code text check (error_code is null or char_length(error_code) <= 100),
  error_message text check (error_message is null or char_length(error_message) <= 1000),
  started_at timestamptz not null default now(),
  finished_at timestamptz not null default now(),
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id) on delete cascade
);
create index analytics_capture_runs_account_idx on public.analytics_capture_runs (social_account_id, started_at desc);
create index analytics_capture_runs_brand_idx on public.analytics_capture_runs (brand_id, started_at desc);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- ¿Sigue siendo provisional una cifra capturada ahora? Las diarias, mientras no
-- haya pasado el retraso de la red desde el final del día; las acumuladas de
-- una publicación, mientras no haya pasado ese retraso desde que salió.
create function private.analytics_is_provisional(
  p_aggregation text, p_delay_hours integer, p_metric_date date, p_published_at timestamptz, p_at timestamptz
) returns boolean
language sql immutable set search_path = '' as $$
  select case p_aggregation
    when 'daily' then p_at < ((p_metric_date + 1)::timestamp at time zone 'UTC') + make_interval(hours => p_delay_hours)
    when 'lifetime' then p_published_at is null or p_at < p_published_at + make_interval(hours => p_delay_hours)
    else false
  end;
$$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Encola una captura por cuenta viva de Instagram y día (UTC). La clave de
-- idempotencia lleva la cuenta y el día: encolar varias veces el mismo día no
-- duplica. Devuelve cuántas cuentas hay.
create function public.analytics_enqueue_captures(p_day date default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := coalesce(p_day, (now() at time zone 'UTC')::date);
  v_account public.social_accounts;
  v_count integer := 0;
begin
  for v_account in
    select * from public.social_accounts a where a.status = 'active' and a.network = 'instagram' order by a.created_at
  loop
    perform public.enqueue_job(
      v_account.organization_id, 'analytics.capture',
      jsonb_build_object('account_id', v_account.id, 'day', v_day),
      'analytics.capture:' || v_account.id || ':' || v_day,
      v_account.brand_id, -10, 5);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Lo que el capturador necesita para medir una cuenta: la cuenta (sin token),
-- las publicaciones hechas por la plataforma en los últimos 60 días, el último
-- día ya capturado y las métricas que se capturan. Si la cuenta no se puede
-- medir, {"outcome": "skip", "reason": …}.
create function public.analytics_capture_begin(p_account_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_account public.social_accounts;
begin
  select * into v_account from public.social_accounts a where a.id = p_account_id;
  if not found then
    return jsonb_build_object('outcome', 'skip', 'reason', 'gone');
  end if;
  if v_account.status <> 'active' then
    return jsonb_build_object('outcome', 'skip', 'reason', v_account.status);
  end if;
  if v_account.network <> 'instagram' then
    return jsonb_build_object('outcome', 'skip', 'reason', 'unsupported_network');
  end if;
  return jsonb_build_object(
    'outcome', 'ready',
    'account', jsonb_build_object('id', v_account.id, 'brand_id', v_account.brand_id,
                                  'organization_id', v_account.organization_id, 'network', v_account.network,
                                  'external_id', v_account.external_id, 'token_expires_at', v_account.token_expires_at),
    'last_metric_date', (select max(m.metric_date) from public.account_metrics_daily m
                         where m.social_account_id = v_account.id
                           and m.metric_id <> 'instagram.account.followers'),
    'media', coalesce((
      select jsonb_agg(jsonb_build_object('publication_id', p.id, 'external_id', p.external_id, 'format', p.format,
                                          'published_at', p.published_at)
                       order by p.published_at desc)
      from public.scheduled_publications p
      where p.social_account_id = v_account.id and p.status = 'published'
        and p.published_at > now() - interval '60 days'
    ), '[]'::jsonb),
    'metrics', (
      select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'scope', d.scope, 'api_name', d.api_name,
                                                   'api_source', d.api_source, 'media_types', d.media_types)
                                order by d.sort), '[]'::jsonb)
      from public.analytics_metric_definitions d
      where d.network = v_account.network and d.status = 'captured'
    )
  );
end $$;

-- Guarda una pasada del capturador: las cifras (actualizando las del mismo día:
-- nunca se duplican) y el registro de la pasada con lo que no se pudo medir.
--   p_account_rows: [{"metric_id": "…", "date": "AAAA-MM-DD", "value": 123}]
--   p_media_rows:   [{"external_id": "…", "metric_id": "…", "date": "AAAA-MM-DD", "value": 123}]
--   p_unavailable:  [{"metric_id": "…", "reason": "…", "message": "…"}]
-- Todo se valida: métrica del catálogo que se captura, del ámbito y la red de
-- la cuenta; publicación hecha por la plataforma en ESA cuenta; fechas de los
-- dos últimos años y no futuras; cifras no negativas.
create function public.analytics_record_capture(
  p_account_id uuid,
  p_job_id uuid,
  p_status text,
  p_started_at timestamptz,
  p_window_from date,
  p_window_to date,
  p_account_rows jsonb,
  p_media_rows jsonb,
  p_unavailable jsonb default '[]'::jsonb,
  p_api_calls integer default 0,
  p_error_code text default null,
  p_error_message text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_account public.social_accounts;
  v_row jsonb;
  v_def public.analytics_metric_definitions;
  v_pub public.scheduled_publications;
  v_date date;
  v_value numeric;
  v_today date := (now() at time zone 'UTC')::date;
  v_account_rows integer := 0;
  v_media_rows integer := 0;
  v_run uuid;
begin
  if p_status is null or p_status not in ('succeeded', 'partial', 'failed', 'skipped') then
    raise exception 'Estado de captura no válido' using errcode = '22023';
  end if;
  select * into v_account from public.social_accounts a where a.id = p_account_id;
  if not found then
    raise exception 'La cuenta no existe' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_account_rows, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_media_rows, '[]'::jsonb)) <> 'array'
     or jsonb_typeof(coalesce(p_unavailable, '[]'::jsonb)) <> 'array' then
    raise exception 'Las cifras llegan como listas' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_account_rows, '[]'::jsonb)) > 5000
     or jsonb_array_length(coalesce(p_media_rows, '[]'::jsonb)) > 5000 then
    raise exception 'Demasiadas cifras en una pasada' using errcode = '22023';
  end if;

  for v_row in select e.value from jsonb_array_elements(coalesce(p_account_rows, '[]'::jsonb)) e loop
    select * into v_def from public.analytics_metric_definitions d
    where d.id = v_row ->> 'metric_id' and d.scope = 'account' and d.status = 'captured'
      and d.network = v_account.network;
    if not found then
      raise exception 'Métrica de cuenta no admitida: %', coalesce(v_row ->> 'metric_id', '(vacía)') using errcode = '22023';
    end if;
    v_date := (v_row ->> 'date')::date;
    v_value := (v_row ->> 'value')::numeric;
    if v_date is null or v_date > v_today or v_date < v_today - 730 then
      raise exception 'Fecha fuera de rango: %', v_row ->> 'date' using errcode = '22023';
    end if;
    if v_value is null or v_value < 0 then
      raise exception 'Cifra no válida en %', v_def.id using errcode = '22023';
    end if;
    insert into public.account_metrics_daily (social_account_id, brand_id, organization_id, metric_id, metric_date, value,
                                              provisional)
    values (v_account.id, v_account.brand_id, v_account.organization_id, v_def.id, v_date, v_value,
            private.analytics_is_provisional(v_def.aggregation, v_def.delay_hours, v_date, null, now()))
    on conflict (social_account_id, metric_id, metric_date) do update
      set value = excluded.value, captured_at = now(),
          capture_count = public.account_metrics_daily.capture_count + 1,
          provisional = excluded.provisional;
    v_account_rows := v_account_rows + 1;
  end loop;

  for v_row in select e.value from jsonb_array_elements(coalesce(p_media_rows, '[]'::jsonb)) e loop
    select * into v_def from public.analytics_metric_definitions d
    where d.id = v_row ->> 'metric_id' and d.scope = 'media' and d.status = 'captured'
      and d.network = v_account.network;
    if not found then
      raise exception 'Métrica de publicación no admitida: %', coalesce(v_row ->> 'metric_id', '(vacía)')
        using errcode = '22023';
    end if;
    select * into v_pub from public.scheduled_publications p
    where p.social_account_id = v_account.id and p.status = 'published' and p.external_id = v_row ->> 'external_id';
    if not found then
      raise exception 'La publicación % no es de esta cuenta o no la hizo la plataforma', v_row ->> 'external_id'
        using errcode = '22023';
    end if;
    if not (case when v_pub.format = 'reel' then 'REELS' else 'FEED' end) = any (v_def.media_types) then
      raise exception 'La métrica % no se aplica a esta publicación', v_def.id using errcode = '22023';
    end if;
    v_date := (v_row ->> 'date')::date;
    v_value := (v_row ->> 'value')::numeric;
    if v_date is null or v_date > v_today or v_date < v_today - 730 then
      raise exception 'Fecha fuera de rango: %', v_row ->> 'date' using errcode = '22023';
    end if;
    if v_value is null or v_value < 0 then
      raise exception 'Cifra no válida en %', v_def.id using errcode = '22023';
    end if;
    insert into public.media_metrics_daily (social_account_id, brand_id, organization_id, publication_id,
                                            external_media_id, media_product_type, published_at, metric_id,
                                            metric_date, value, provisional)
    values (v_account.id, v_account.brand_id, v_account.organization_id, v_pub.id, v_pub.external_id,
            case when v_pub.format = 'reel' then 'REELS' else 'FEED' end, v_pub.published_at, v_def.id, v_date,
            v_value,
            private.analytics_is_provisional(v_def.aggregation, v_def.delay_hours, v_date, v_pub.published_at, now()))
    on conflict (social_account_id, external_media_id, metric_id, metric_date) do update
      set value = excluded.value, captured_at = now(),
          capture_count = public.media_metrics_daily.capture_count + 1,
          provisional = excluded.provisional, publication_id = excluded.publication_id;
    v_media_rows := v_media_rows + 1;
  end loop;

  insert into public.analytics_capture_runs (social_account_id, brand_id, organization_id, job_id, status, window_from,
                                             window_to, api_calls, account_rows, media_rows, unavailable, error_code,
                                             error_message, started_at, finished_at)
  values (v_account.id, v_account.brand_id, v_account.organization_id, p_job_id, p_status, p_window_from, p_window_to,
          greatest(coalesce(p_api_calls, 0), 0), v_account_rows, v_media_rows,
          coalesce((select jsonb_agg(jsonb_build_object('metric_id', left(u.value ->> 'metric_id', 120),
                                                        'reason', left(u.value ->> 'reason', 60),
                                                        'message', left(u.value ->> 'message', 300)))
                    from (select e.value from jsonb_array_elements(coalesce(p_unavailable, '[]'::jsonb)) e limit 100) u),
                   '[]'::jsonb),
          left(p_error_code, 100), left(p_error_message, 1000), coalesce(p_started_at, now()), now())
  returning id into v_run;

  return jsonb_build_object('run_id', v_run, 'account_rows', v_account_rows, 'media_rows', v_media_rows);
end $$;

-- Aplaza un trabajo de analítica sin gastar intento (límite de llamadas de la API).
create function public.analytics_defer_job(p_job_id uuid, p_worker text, p_seconds integer, p_message text default null)
returns public.jobs
language plpgsql security definer set search_path = '' as $$
declare
  v_job public.jobs;
begin
  if p_seconds is null or p_seconds not between 5 and 86400 then
    raise exception 'El aplazamiento debe durar entre 5 segundos y un día' using errcode = '22023';
  end if;
  update public.jobs j
  set status = 'queued', locked_by = null, locked_until = null, attempts = greatest(j.attempts - 1, 0),
      run_after = now() + make_interval(secs => p_seconds),
      last_error = coalesce(left(p_message, 1000), j.last_error)
  where j.id = p_job_id and j.status = 'running' and j.locked_by = p_worker
    and j.kind in ('analytics.capture', 'analytics.report')
  returning * into v_job;
  if not found then
    raise exception 'El trabajo no está reservado por este trabajador' using errcode = 'P0001';
  end if;
  return v_job;
end $$;

-- ─────────────────────── Lectura para el panel ───────────────────────

-- Publicaciones de la marca con su última cifra de cada métrica (las hechas
-- por la plataforma que tienen alguna captura). SECURITY INVOKER: la RLS de
-- cada tabla decide qué ve quien llama.
create function public.analytics_media_summary(p_brand_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  publication_id uuid,
  content_id uuid,
  title text,
  format text,
  network text,
  media_product_type text,
  external_media_id text,
  external_url text,
  published_at timestamptz,
  last_captured_at timestamptz,
  provisional boolean,
  metrics jsonb
)
language sql stable security invoker set search_path = '' as $$
  with latest as (
    select distinct on (m.external_media_id, m.metric_id)
      m.external_media_id, m.metric_id, m.value, m.captured_at, m.provisional, m.publication_id,
      m.media_product_type, m.published_at
    from public.media_metrics_daily m
    where m.brand_id = p_brand_id and m.published_at >= p_from and m.published_at < p_to
    order by m.external_media_id, m.metric_id, m.metric_date desc
  )
  select l.publication_id, p.content_id, coalesce(c.title, '(pieza borrada)'), coalesce(p.format, ''),
         coalesce(p.network, 'instagram'), l.media_product_type, l.external_media_id, p.external_url,
         min(l.published_at), max(l.captured_at), bool_or(l.provisional),
         jsonb_object_agg(l.metric_id, l.value)
  from latest l
  left join public.scheduled_publications p on p.id = l.publication_id
  left join public.content_items c on c.id = p.content_id
  group by l.publication_id, p.content_id, c.title, p.format, p.network, l.media_product_type, l.external_media_id,
           p.external_url
  order by min(l.published_at) desc;
$$;

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.analytics_metric_definitions enable row level security;
alter table public.account_metrics_daily enable row level security;
alter table public.media_metrics_daily enable row level security;
alter table public.analytics_capture_runs enable row level security;

-- El catálogo es de la plataforma: lo lee cualquiera con sesión, nadie lo escribe.
create policy analytics_metric_definitions_select on public.analytics_metric_definitions for select to authenticated
  using (true);
create policy account_metrics_daily_select on public.account_metrics_daily for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy media_metrics_daily_select on public.media_metrics_daily for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy analytics_capture_runs_select on public.analytics_capture_runs for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on public.analytics_metric_definitions, public.account_metrics_daily, public.media_metrics_daily,
  public.analytics_capture_runs from public, anon, authenticated;
grant select on public.analytics_metric_definitions, public.account_metrics_daily, public.media_metrics_daily,
  public.analytics_capture_runs to authenticated, service_role;

revoke all on function private.analytics_is_provisional(text, integer, date, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.analytics_enqueue_captures(date) from public, anon, authenticated;
revoke all on function public.analytics_capture_begin(uuid) from public, anon, authenticated;
revoke all on function public.analytics_record_capture(uuid, uuid, text, timestamptz, date, date, jsonb, jsonb, jsonb,
                                                        integer, text, text) from public, anon, authenticated;
revoke all on function public.analytics_defer_job(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.analytics_media_summary(uuid, timestamptz, timestamptz) from public, anon;

grant execute on function public.analytics_enqueue_captures(date) to service_role;
grant execute on function public.analytics_capture_begin(uuid) to service_role;
grant execute on function public.analytics_record_capture(uuid, uuid, text, timestamptz, date, date, jsonb, jsonb, jsonb,
                                                           integer, text, text) to service_role;
grant execute on function public.analytics_defer_job(uuid, text, integer, text) to service_role;
grant execute on function public.analytics_media_summary(uuid, timestamptz, timestamptz) to authenticated;
