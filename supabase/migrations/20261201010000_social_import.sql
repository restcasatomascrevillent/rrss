-- Importar las publicaciones que una cuenta ya tiene en Instagram (docs/importar-publicaciones.md).
--
-- Para qué: sacar de lo que la marca ya publicó sus plantillas de diseño, para
-- mantener su estilo. Se hace por la Graph API con la cuenta conectada y el
-- token no sale nunca del servidor (`social-import` lo descifra y lo usa).
--
--   * `social_imported_media` guarda lo que da `/{ig-user-id}/media`: una fila
--     por publicación de la red y cuenta (identificador, pie, tipo, direcciones
--     de las imágenes, enlace, fecha y las piezas de un carrusel). Importar de
--     nuevo la misma cuenta actualiza la fila: nunca duplica.
--   * `social_import_runs` es una importación: dónde va (cursor de Meta), qué
--     lleva y si copia las imágenes a la biblioteca. Hay como mucho una abierta
--     por cuenta; volver a pulsar «Importar» la REANUDA. Cada página se guarda
--     y adelanta el cursor en la misma transacción, así que parar a mitad no
--     pierde nada. Un cerrojo corto (`lease_until`) impide dos pasos a la vez.
--   * Copiar las imágenes a la biblioteca es opcional (`copy_images`): quedan
--     como recursos de la carpeta «Instagram / Publicadas», con su procedencia
--     (enlace y fecha) y en el almacén activo (R2 o Supabase) como el resto de
--     subidas. Lo hace el servidor; el límite de almacenamiento del plan se
--     comprueba aquí porque la clave de servicio no pasa por el disparador.
--   * `brand_design_templates` son las plantillas de diseño de la marca: un
--     documento v3 importable y su análisis (formato, capas, tipografías,
--     colores, logotipo, foto, tono y ejemplos con su enlace). Las entrega la
--     agencia (o quien edita la marca) con `deliver_design_templates`.
--
-- Nadie escribe estas tablas desde la API: todo pasa por funciones. Las que
-- llama el servidor solo las ejecuta la clave de servicio, y comprueban que la
-- persona que lo pidió gestiona la marca.

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.social_import_runs (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  -- running: se puede seguir · paused: detenida (por la persona, por un error o
  -- por el límite de la red) · completed: terminada.
  status text not null default 'running' check (status in ('running', 'paused', 'completed')),
  -- listing: recorriendo /media · copying: copiando imágenes a la biblioteca · done.
  phase text not null default 'listing' check (phase in ('listing', 'copying', 'done')),
  copy_images boolean not null default false,
  -- Cursor `after` de Meta de la siguiente página; null = empezar o ya no hay más.
  after_cursor text check (after_cursor is null or char_length(after_cursor) <= 2000),
  pages integer not null default 0 check (pages >= 0),
  items_seen integer not null default 0 check (items_seen >= 0),
  items_new integer not null default 0 check (items_new >= 0),
  copied integer not null default 0 check (copied >= 0),
  copy_failed integer not null default 0 check (copy_failed >= 0),
  -- La red pidió esperar (límite de llamadas): no se sigue antes.
  retry_after timestamptz,
  -- Cerrojo de un paso en marcha: otro paso no entra hasta que caduque o termine.
  lease_until timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  started_by uuid references auth.users (id) on delete set null,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id) on delete cascade,
  check ((status = 'completed') = (finished_at is not null))
);
-- Una importación abierta por cuenta.
create unique index social_import_runs_open_idx on public.social_import_runs (social_account_id)
  where status <> 'completed';
create index social_import_runs_brand_idx on public.social_import_runs (brand_id, started_at desc);

create table public.social_imported_media (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  network text not null default 'instagram' check (network = 'instagram'),
  -- Identificador de la publicación en la red.
  external_id text not null check (char_length(external_id) between 1 and 100),
  caption text check (caption is null or char_length(caption) <= 5000),
  -- IMAGE, VIDEO o CAROUSEL_ALBUM; y FEED, REELS, STORY o AD (como los llama la API).
  media_type text not null check (char_length(media_type) between 1 and 30),
  media_product_type text check (media_product_type is null or char_length(media_product_type) between 1 and 30),
  -- Direcciones de la CDN de Meta: CADUCAN. Sirven para copiar ahora, no para guardar.
  media_url text check (media_url is null or char_length(media_url) <= 2000),
  thumbnail_url text check (thumbnail_url is null or char_length(thumbnail_url) <= 2000),
  permalink text check (permalink is null or char_length(permalink) <= 500),
  published_at timestamptz,
  -- Piezas de un carrusel: [{"id", "media_type", "media_url", "thumbnail_url"}].
  children jsonb not null default '[]'::jsonb
    check (jsonb_typeof(children) = 'array' and jsonb_array_length(children) <= 20
           and pg_column_size(children) <= 24000),
  -- none: no se pidió copiar · pending: falta copiarla · copied · failed · skipped (nada que copiar).
  copy_status text not null default 'none' check (copy_status in ('none', 'pending', 'copied', 'failed', 'skipped')),
  copy_error text check (copy_error is null or char_length(copy_error) <= 500),
  -- Recursos de la biblioteca que salen de esta publicación.
  asset_ids uuid[] not null default '{}' check (cardinality(asset_ids) <= 20),
  copied_at timestamptz,
  first_imported_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  foreign key (social_account_id, brand_id, organization_id)
    references public.social_accounts (id, brand_id, organization_id) on delete cascade,
  unique (social_account_id, external_id)
);
create index social_imported_media_brand_idx on public.social_imported_media (brand_id, published_at desc);
create index social_imported_media_copy_idx on public.social_imported_media (social_account_id)
  where copy_status = 'pending';

create table public.brand_design_templates (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Clave estable dentro de la marca: entregar otra vez la misma la actualiza.
  template_key text not null check (template_key ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  name text not null check (char_length(name) between 1 and 120),
  network text not null check (char_length(network) between 1 and 40),
  format text not null check (char_length(format) between 1 and 40),
  -- Documento v3 de la aplicación (la validación completa es la del esquema en la aplicación).
  document jsonb not null check (jsonb_typeof(document) = 'object' and (document ->> 'schemaVersion') = '3'
                                 and pg_column_size(document) <= 262144),
  -- Qué se vio en las publicaciones: formato, capas, tipografías, colores, logotipo, foto, tono y ejemplos.
  analysis jsonb not null default '{}'::jsonb check (jsonb_typeof(analysis) = 'object'
                                                     and pg_column_size(analysis) <= 65536),
  source text not null default 'instagram_import' check (source in ('instagram_import', 'manual')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  unique (brand_id, template_key)
);
create index brand_design_templates_brand_idx on public.brand_design_templates (brand_id, created_at desc);

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.social_import_runs enable row level security;
alter table public.social_imported_media enable row level security;
alter table public.brand_design_templates enable row level security;

-- Lo ve quien ve la marca. No hay políticas de escritura.
create policy social_import_runs_select on public.social_import_runs for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy social_imported_media_select on public.social_imported_media for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy brand_design_templates_select on public.brand_design_templates for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Disparadores ─────────────────────────────

create trigger social_import_runs_touch before update on public.social_import_runs
  for each row execute function private.touch_updated_at();
create trigger brand_design_templates_touch before update on public.brand_design_templates
  for each row execute function private.touch_updated_at();

-- ─────────────────────────── RPC para personas ───────────────────────────

-- Empieza la importación de una cuenta, o REANUDA la que está abierta. Solo
-- quien gestiona la marca (como conectar la cuenta). Si ya había una abierta y
-- ahora se pide copiar las imágenes, pasa a copiarlas.
create function public.social_import_begin(p_account_id uuid, p_copy_images boolean default false)
returns public.social_import_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_account public.social_accounts;
  v_run public.social_import_runs;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  select * into v_account from public.social_accounts a where a.id = p_account_id;
  if not found or not private.user_has_brand_capability(v_uid, v_account.brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede importar sus publicaciones' using errcode = '42501';
  end if;
  if v_account.status <> 'active' then
    raise exception 'La cuenta no está conectada: vuelve a conectarla antes de importar' using errcode = 'P0001';
  end if;
  if v_account.network <> 'instagram' then
    raise exception 'Por ahora solo se importan publicaciones de Instagram' using errcode = 'P0001';
  end if;

  select * into v_run from public.social_import_runs r
  where r.social_account_id = p_account_id and r.status <> 'completed' for update;
  if found then
    update public.social_import_runs r
    set status = 'running', last_error = null, copy_images = r.copy_images or coalesce(p_copy_images, false)
    where r.id = v_run.id returning * into v_run;
    return v_run;
  end if;

  insert into public.social_import_runs (social_account_id, brand_id, organization_id, copy_images, started_by)
  values (v_account.id, v_account.brand_id, v_account.organization_id, coalesce(p_copy_images, false), v_uid)
  returning * into v_run;
  return v_run;
end $$;

-- Detiene la importación (no se pierde nada: reanudar sigue donde iba).
create function public.social_import_pause(p_run_id uuid)
returns public.social_import_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_run public.social_import_runs;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  select * into v_run from public.social_import_runs r where r.id = p_run_id for update;
  if not found or not private.user_has_brand_capability(v_uid, v_run.brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede detener la importación' using errcode = '42501';
  end if;
  if v_run.status = 'completed' then
    return v_run;
  end if;
  update public.social_import_runs r set status = 'paused', lease_until = null
  where r.id = v_run.id returning * into v_run;
  return v_run;
end $$;

-- Borra una plantilla de diseño de la marca. Quien edita la marca.
create function public.delete_design_template(p_template_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_brand uuid;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  select t.brand_id into v_brand from public.brand_design_templates t where t.id = p_template_id;
  if not found or not private.user_has_brand_capability(v_uid, v_brand, 'edit') then
    raise exception 'Solo quien edita la marca puede borrar sus plantillas' using errcode = '42501';
  end if;
  delete from public.brand_design_templates t where t.id = p_template_id;
end $$;

-- Entrega plantillas de diseño de una marca (quien edita la marca: la sesión de
-- la agencia desde `agency/`, o la propia marca). Lista de
--   {"key", "name", "network", "format", "document", "analysis"}.
-- El documento v3 y el análisis los valida antes la herramienta con el esquema de
-- la aplicación; aquí se exige la forma, que los recursos del documento sean de
-- la marca y que cada ejemplo del análisis sea una publicación importada de la
-- marca (no se pueden inventar ejemplos). Misma clave = se actualiza.
create function public.deliver_design_templates(p_brand_id uuid, p_templates jsonb)
returns setof public.brand_design_templates
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_org uuid;
  v_item jsonb;
  v_layer jsonb;
  v_example jsonb;
  v_asset text;
  v_row public.brand_design_templates;
begin
  if v_uid is null then
    raise exception 'Hace falta iniciar sesión' using errcode = '28000';
  end if;
  if p_brand_id is null or not private.user_has_brand_capability(v_uid, p_brand_id, 'edit') then
    raise exception 'Solo quien edita la marca puede entregar plantillas' using errcode = '42501';
  end if;
  select b.organization_id into v_org from public.brands b where b.id = p_brand_id;
  if p_templates is null or jsonb_typeof(p_templates) <> 'array'
     or jsonb_array_length(p_templates) not between 1 and 12 then
    raise exception 'Hay que entregar entre 1 y 12 plantillas' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_templates) loop
    if jsonb_typeof(v_item -> 'document') <> 'object' or jsonb_typeof(v_item -> 'analysis') <> 'object' then
      raise exception 'Cada plantilla necesita un documento y un análisis' using errcode = '22023';
    end if;
    -- Los recursos del documento (imágenes y logotipo) son de esta marca.
    for v_layer in select * from jsonb_array_elements(coalesce(v_item #> '{document,layers}', '[]'::jsonb)) loop
      v_asset := case v_layer ->> 'type'
        when 'image' then case when v_layer #>> '{source,kind}' = 'asset' then v_layer #>> '{source,assetId}' end
        when 'logo' then v_layer ->> 'assetId'
      end;
      if v_asset is not null and (v_asset !~ '^[0-9a-f-]{36}$' or not exists (
           select 1 from public.media_assets a where a.id = v_asset::uuid and a.brand_id = p_brand_id)) then
        raise exception 'El documento usa un recurso que no es de la biblioteca de la marca' using errcode = '22023';
      end if;
    end loop;
    -- Los ejemplos son publicaciones importadas de la marca.
    for v_example in select * from jsonb_array_elements(coalesce(v_item #> '{analysis,examples}', '[]'::jsonb)) loop
      if not exists (select 1 from public.social_imported_media m
                     where m.brand_id = p_brand_id and m.permalink = v_example ->> 'permalink') then
        raise exception 'Un ejemplo no es una publicación importada de la marca: %',
          left(coalesce(v_example ->> 'permalink', ''), 120) using errcode = '22023';
      end if;
    end loop;

    insert into public.brand_design_templates (brand_id, organization_id, template_key, name, network, format,
                                               document, analysis, source, created_by)
    values (p_brand_id, v_org, v_item ->> 'key', v_item ->> 'name', v_item ->> 'network', v_item ->> 'format',
            v_item -> 'document', v_item -> 'analysis', 'instagram_import', v_uid)
    on conflict (brand_id, template_key) do update
      set name = excluded.name, network = excluded.network, format = excluded.format,
          document = excluded.document, analysis = excluded.analysis, source = excluded.source
    returning * into v_row;
    return next v_row;
  end loop;
end $$;

-- ─────────────────────── RPC del servidor (clave de servicio) ───────────────────────

-- Reserva un paso de la importación para `social-import`: comprueba que quien lo
-- pide gestiona la marca y que la cuenta sigue conectada, respeta la espera que
-- pidió la red y el cerrojo de otro paso, y devuelve lo que hace falta para
-- hablar con la red (sin el token: ese lo pide `social_account_token`).
create function public.social_import_claim(p_run_id uuid, p_user_id uuid, p_lease_seconds integer default 120)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.social_import_runs;
  v_account public.social_accounts;
begin
  select * into v_run from public.social_import_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'La importación no existe' using errcode = 'P0001';
  end if;
  if p_user_id is null or not private.user_has_brand_capability(p_user_id, v_run.brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede importar sus publicaciones' using errcode = '42501';
  end if;
  if v_run.status = 'completed' then
    return jsonb_build_object('outcome', 'completed', 'run', to_jsonb(v_run));
  end if;
  select * into v_account from public.social_accounts a where a.id = v_run.social_account_id;
  if v_account.status <> 'active' then
    raise exception 'La cuenta no está conectada: vuelve a conectarla antes de importar' using errcode = 'P0001';
  end if;
  if v_run.status = 'paused' then
    return jsonb_build_object('outcome', 'paused', 'run', to_jsonb(v_run));
  end if;
  if v_run.retry_after is not null and v_run.retry_after > now() then
    return jsonb_build_object('outcome', 'waiting', 'run', to_jsonb(v_run));
  end if;
  if v_run.lease_until is not null and v_run.lease_until > now() then
    return jsonb_build_object('outcome', 'busy', 'run', to_jsonb(v_run));
  end if;
  update public.social_import_runs r
  set lease_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_seconds, 120), 600))),
      retry_after = null
  where r.id = v_run.id returning * into v_run;
  return jsonb_build_object(
    'outcome', 'ready', 'run', to_jsonb(v_run),
    'account', jsonb_build_object('id', v_account.id, 'brand_id', v_account.brand_id,
                                  'organization_id', v_account.organization_id, 'network', v_account.network,
                                  'external_id', v_account.external_id,
                                  'token_expires_at', v_account.token_expires_at));
end $$;

-- Guarda una página de /media y adelanta el cursor EN LA MISMA transacción:
-- parar a mitad no pierde ni repite nada. `p_from_cursor` es el cursor con el
-- que se pidió la página; si ya no es el de la importación (otro paso se
-- adelantó), las publicaciones se guardan igual (no duplican) pero el cursor no
-- retrocede. `p_items`: lista de
--   {"id", "caption", "media_type", "media_product_type", "media_url",
--    "thumbnail_url", "permalink", "timestamp", "children": [...]}.
create function public.social_import_save_page(
  p_run_id uuid,
  p_items jsonb,
  p_from_cursor text,
  p_next_cursor text
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.social_import_runs;
  v_item jsonb;
  v_new integer := 0;
  v_seen integer := 0;
  v_inserted boolean;
  v_stale boolean;
  v_last boolean := p_next_cursor is null;
begin
  select * into v_run from public.social_import_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'La importación no existe' using errcode = 'P0001';
  end if;
  if v_run.status = 'completed' or v_run.phase <> 'listing' then
    return jsonb_build_object('stale', true, 'run', to_jsonb(v_run));
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 100 then
    raise exception 'Una página trae entre 0 y 100 publicaciones' using errcode = '22023';
  end if;
  if v_run.pages >= 2000 then
    raise exception 'La importación llegó al máximo de 2000 páginas' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.social_imported_media (social_account_id, brand_id, organization_id, external_id, caption,
                                              media_type, media_product_type, media_url, thumbnail_url, permalink,
                                              published_at, children)
    values (v_run.social_account_id, v_run.brand_id, v_run.organization_id, v_item ->> 'id',
            left(v_item ->> 'caption', 5000), coalesce(nullif(v_item ->> 'media_type', ''), 'IMAGE'),
            nullif(v_item ->> 'media_product_type', ''), nullif(v_item ->> 'media_url', ''),
            nullif(v_item ->> 'thumbnail_url', ''), nullif(v_item ->> 'permalink', ''),
            nullif(v_item ->> 'timestamp', '')::timestamptz,
            case when jsonb_typeof(v_item -> 'children') = 'array' then v_item -> 'children' else '[]'::jsonb end)
    on conflict (social_account_id, external_id) do update
      set caption = excluded.caption, media_type = excluded.media_type,
          media_product_type = excluded.media_product_type, media_url = excluded.media_url,
          thumbnail_url = excluded.thumbnail_url, permalink = excluded.permalink,
          published_at = excluded.published_at, children = excluded.children, last_seen_at = now()
    returning (xmax = 0) into v_inserted;
    v_seen := v_seen + 1;
    if v_inserted then v_new := v_new + 1; end if;
  end loop;

  v_stale := v_run.after_cursor is distinct from p_from_cursor;
  if v_stale then
    return jsonb_build_object('stale', true, 'saved', v_seen, 'new', v_new, 'run', to_jsonb(v_run));
  end if;

  if v_last and v_run.copy_images then
    -- Fin del recorrido: lo que falta por copiar queda pendiente (también lo que falló antes).
    update public.social_imported_media m set copy_status = 'pending', copy_error = null
    where m.social_account_id = v_run.social_account_id and m.copy_status in ('none', 'failed');
  end if;

  update public.social_import_runs r
  set after_cursor = p_next_cursor, pages = r.pages + 1, items_seen = r.items_seen + v_seen,
      items_new = r.items_new + v_new, last_error = null,
      phase = case when not v_last then 'listing' when r.copy_images then 'copying' else 'done' end,
      status = case when v_last and not r.copy_images then 'completed' else r.status end,
      finished_at = case when v_last and not r.copy_images then now() else r.finished_at end,
      lease_until = case when v_last and not r.copy_images then null else r.lease_until end
  where r.id = v_run.id returning * into v_run;
  return jsonb_build_object('stale', false, 'saved', v_seen, 'new', v_new, 'run', to_jsonb(v_run));
end $$;

-- Publicaciones que faltan por copiar a la biblioteca (las más recientes primero).
create function public.social_import_pending_copies(p_run_id uuid, p_limit integer default 5)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb)
  from (
    select m.id, m.external_id, m.media_type, m.media_url, m.thumbnail_url, m.permalink, m.published_at, m.children
    from public.social_imported_media m
    join public.social_import_runs r on r.social_account_id = m.social_account_id
    where r.id = p_run_id and m.copy_status = 'pending'
    order by m.published_at desc nulls last, m.id
    limit greatest(1, least(coalesce(p_limit, 5), 20))
  ) x;
$$;

-- ¿Cabe lo que se va a copiar en el plan? La clave de servicio no pasa por el
-- disparador de límites, así que se comprueba aquí ANTES de subir el archivo.
create function public.social_import_check_space(p_run_id uuid, p_bytes bigint)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select r.organization_id into v_org from public.social_import_runs r where r.id = p_run_id;
  if not found then
    raise exception 'La importación no existe' using errcode = 'P0001';
  end if;
  perform private.check_storage_limit(v_org, greatest(coalesce(p_bytes, 0), 1));
end $$;

-- Da de alta en la biblioteca los archivos copiados de una publicación. `p_files`:
--   [{"path", "file_name", "mime_type", "bytes", "width", "height", "index", "kind"}]
-- (kind: image o video_thumbnail). La ruta es de la marca, bajo `instagram/`, y
-- la procedencia (enlace y fecha de la publicación) no se puede cambiar después.
-- Repetirlo no duplica (la ruta es única).
create function public.social_import_register_copy(
  p_run_id uuid,
  p_user_id uuid,
  p_imported_id uuid,
  p_files jsonb
) returns uuid[]
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.social_import_runs;
  v_media public.social_imported_media;
  v_file jsonb;
  v_prefix text;
  v_asset public.media_assets;
  v_ids uuid[] := '{}';
begin
  select * into v_run from public.social_import_runs r where r.id = p_run_id;
  if not found or p_user_id is null or not private.user_has_brand_capability(p_user_id, v_run.brand_id, 'manage') then
    raise exception 'Solo quien gestiona la marca puede importar sus publicaciones' using errcode = '42501';
  end if;
  select * into v_media from public.social_imported_media m
  where m.id = p_imported_id and m.social_account_id = v_run.social_account_id for update;
  if not found then
    raise exception 'La publicación importada no existe' using errcode = 'P0001';
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) not between 1 and 20 then
    raise exception 'Hay que dar de alta entre 1 y 20 archivos' using errcode = '22023';
  end if;
  v_prefix := v_run.organization_id::text || '/' || v_run.brand_id::text || '/instagram/';

  for v_file in select * from jsonb_array_elements(p_files) loop
    if coalesce(v_file ->> 'path', '') not like v_prefix || '%'
       or (v_file ->> 'path') ~ '(^|/)\.{1,2}(/|$)' or (v_file ->> 'path') ~ '//'
       or coalesce(v_file ->> 'mime_type', '') not in ('image/jpeg', 'image/png', 'image/webp') then
      raise exception 'Archivo no válido para la biblioteca' using errcode = '22023';
    end if;
    select * into v_asset from public.media_assets a where a.storage_path = v_file ->> 'path';
    if not found then
      insert into public.media_assets (brand_id, organization_id, kind, origin, storage_path, file_name, mime_type,
                                       bytes, width, height, folder, tags, created_by, provenance)
      values (v_run.brand_id, v_run.organization_id, 'image', 'import', v_file ->> 'path',
              left(coalesce(nullif(v_file ->> 'file_name', ''), 'instagram.jpg'), 255), v_file ->> 'mime_type',
              greatest(coalesce((v_file ->> 'bytes')::bigint, 0), 0),
              nullif((v_file ->> 'width')::integer, 0), nullif((v_file ->> 'height')::integer, 0),
              'Instagram / Publicadas', array['instagram', 'publicada'], p_user_id,
              jsonb_build_object('type', 'instagram_import', 'media_id', v_media.external_id,
                                 'permalink', v_media.permalink, 'published_at', v_media.published_at,
                                 'index', coalesce((v_file ->> 'index')::integer, 0),
                                 'kind', coalesce(nullif(v_file ->> 'kind', ''), 'image')))
      returning * into v_asset;
    end if;
    v_ids := v_ids || v_asset.id;
  end loop;

  update public.social_imported_media m
  set copy_status = 'copied', copy_error = null, asset_ids = v_ids, copied_at = now()
  where m.id = v_media.id;
  update public.social_import_runs r set copied = r.copied + 1 where r.id = v_run.id;
  return v_ids;
end $$;

-- Una publicación que no se pudo copiar (imagen caducada, sin espacio…): queda
-- anotada y la importación sigue con las demás.
create function public.social_import_mark_copy(p_run_id uuid, p_imported_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.social_import_runs;
begin
  if p_status not in ('failed', 'skipped') then
    raise exception 'Estado de copia no válido' using errcode = '22023';
  end if;
  select * into v_run from public.social_import_runs r where r.id = p_run_id;
  if not found then
    raise exception 'La importación no existe' using errcode = 'P0001';
  end if;
  update public.social_imported_media m
  set copy_status = p_status, copy_error = left(p_reason, 500)
  where m.id = p_imported_id and m.social_account_id = v_run.social_account_id and m.copy_status = 'pending';
  if found and p_status = 'failed' then
    update public.social_import_runs r set copy_failed = r.copy_failed + 1 where r.id = v_run.id;
  end if;
end $$;

-- Cierra un paso: suelta el cerrojo y, según cómo fue, deja la importación en
-- marcha, en pausa (error) o en espera (límite de la red). Si ya no queda nada
-- por copiar, la termina. Devuelve la importación.
create function public.social_import_end_step(
  p_run_id uuid,
  p_error text default null,
  p_retry_seconds integer default null,
  p_pause boolean default false
) returns public.social_import_runs
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.social_import_runs;
begin
  select * into v_run from public.social_import_runs r where r.id = p_run_id for update;
  if not found then
    raise exception 'La importación no existe' using errcode = 'P0001';
  end if;
  if v_run.status = 'completed' then
    return v_run;
  end if;
  update public.social_import_runs r
  set lease_until = null,
      last_error = case when p_error is null then r.last_error else left(p_error, 1000) end,
      retry_after = case when p_retry_seconds is null then null
                         else now() + make_interval(secs => greatest(5, least(p_retry_seconds, 86400))) end,
      status = case when coalesce(p_pause, false) and r.status = 'running' then 'paused' else r.status end
  where r.id = v_run.id returning * into v_run;

  if v_run.phase = 'copying' and v_run.status = 'running' and not exists (
       select 1 from public.social_imported_media m
       where m.social_account_id = v_run.social_account_id and m.copy_status = 'pending') then
    update public.social_import_runs r
    set phase = 'done', status = 'completed', finished_at = now(), retry_after = null
    where r.id = v_run.id returning * into v_run;
  end if;
  return v_run;
end $$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on public.social_import_runs, public.social_imported_media, public.brand_design_templates
  from public, anon, authenticated;
grant select on public.social_import_runs, public.social_imported_media, public.brand_design_templates
  to authenticated, service_role;

revoke all on function public.social_import_begin(uuid, boolean) from public, anon, authenticated;
revoke all on function public.social_import_pause(uuid) from public, anon, authenticated;
revoke all on function public.delete_design_template(uuid) from public, anon, authenticated;
revoke all on function public.deliver_design_templates(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.social_import_claim(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.social_import_save_page(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.social_import_pending_copies(uuid, integer) from public, anon, authenticated;
revoke all on function public.social_import_check_space(uuid, bigint) from public, anon, authenticated;
revoke all on function public.social_import_register_copy(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.social_import_mark_copy(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.social_import_end_step(uuid, text, integer, boolean) from public, anon, authenticated;

grant execute on function public.social_import_begin(uuid, boolean) to authenticated;
grant execute on function public.social_import_pause(uuid) to authenticated;
grant execute on function public.delete_design_template(uuid) to authenticated;
grant execute on function public.deliver_design_templates(uuid, jsonb) to authenticated;
grant execute on function public.social_import_claim(uuid, uuid, integer) to service_role;
grant execute on function public.social_import_save_page(uuid, jsonb, text, text) to service_role;
grant execute on function public.social_import_pending_copies(uuid, integer) to service_role;
grant execute on function public.social_import_check_space(uuid, bigint) to service_role;
grant execute on function public.social_import_register_copy(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.social_import_mark_copy(uuid, uuid, text, text) to service_role;
grant execute on function public.social_import_end_step(uuid, text, integer, boolean) to service_role;
