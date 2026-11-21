-- Fase 2 · Registro de modelos de imagen y vídeo generativos, con su precio.
--
-- Qué modelo sirve cada tarea, cuánto cuesta y qué pasa con los datos es
-- DATO, no código (docs/01-arquitectura.md, §5): los modelos se renuevan cada
-- pocos meses y sus precios cambian sin aviso.
--
--   * Es catálogo de la plataforma, no dato de ningún cliente: lo lee cualquier
--     usuario autenticado y solo lo escribe un superadministrador (o el
--     servidor, con la clave de servicio).
--   * Un precio no es verdad porque esté en una tabla: cada fila dice de qué
--     fecha es y de qué página salió, y si alguien lo ha contrastado. Un modelo
--     con el precio SIN VERIFICAR no se puede activar.
--   * Nada se activa aquí. El dueño todavía no ha elegido proveedor: las filas
--     sembradas quedan inactivas hasta que un superadministrador las active.
--   * `price_micros` va en millonésimas de la moneda del proveedor
--     (`price_currency`). La conversión a la moneda de cuenta de la plataforma
--     es una decisión pendiente del dueño (docs/ESTADO.md).

create table public.ai_media_models (
  id uuid primary key default gen_random_uuid(),
  -- Identificador del adaptador (supabase/functions/_shared/ai/media/).
  provider text not null check (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
  -- Nombre del modelo tal como lo entiende ese proveedor (en algunos es la
  -- ruta del endpoint).
  model text not null check (char_length(model) between 1 and 128),
  task public.ai_task not null check (task in ('image', 'video')),
  display_name text not null check (char_length(display_name) between 1 and 120),
  -- Unidad de cobro: por imagen, por megapíxel o por segundo de vídeo.
  billing_unit text not null check (billing_unit in ('image', 'megapixel', 'second')),
  price_micros bigint not null check (price_micros >= 0),
  -- Matices de la tarifa que no caben en un solo precio. Claves reconocidas:
  --   first_unit_micros        precio de la primera unidad, si es distinto
  --   input_megapixel_micros   recargo por megapíxel de imagen de referencia
  price_details jsonb not null default '{}'::jsonb check (jsonb_typeof(price_details) = 'object'),
  price_currency text not null default 'USD' check (price_currency ~ '^[A-Z]{3}$'),
  price_checked_on date not null,
  price_source text not null check (char_length(price_source) between 1 and 500),
  price_verified boolean not null default false,
  -- Dónde se procesan los datos según la documentación del proveedor.
  -- 'unknown' = no lo dice: se trata como fuera de la UE.
  data_region text not null check (data_region in ('eu', 'us', 'global', 'unknown')),
  -- ¿Puede el proveedor entrenar sus modelos con lo que se le envía?
  trains_on_inputs text not null check (trains_on_inputs in ('no', 'yes', 'unknown')),
  -- Cómo entrega el resultado: en la misma petición o por trabajo asíncrono.
  delivery text not null check (delivery in ('sync', 'async')),
  -- Ajustes que el adaptador necesita de este modelo: nombres de los campos
  -- de la petición, duraciones admitidas, tamaño de imagen…
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  -- Mayor número = se prefiere antes.
  priority integer not null default 0 check (priority between -100 and 100),
  active boolean not null default false,
  notes text not null default '' check (char_length(notes) <= 1000),
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, model),
  -- La unidad de cobro tiene que casar con lo que se genera.
  check ((task = 'video') = (billing_unit = 'second')),
  -- Sin precio contrastado no hay reserva de cupo fiable: no se activa.
  check (not active or price_verified)
);
create index ai_media_models_active_idx on public.ai_media_models (task, priority desc) where active;

create function private.ai_media_models_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_by := coalesce((select auth.uid()), new.updated_by);
  return new;
end $$;

create trigger ai_media_models_touch before update on public.ai_media_models
  for each row execute function private.touch_updated_at();
create trigger ai_media_models_stamp before insert or update on public.ai_media_models
  for each row execute function private.ai_media_models_stamp();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.ai_media_models enable row level security;

-- Catálogo de plataforma: lo lee cualquier usuario con sesión.
create policy ai_media_models_select on public.ai_media_models for select to authenticated
  using (true);
-- Solo lo escriben los superadministradores.
create policy ai_media_models_insert on public.ai_media_models for insert to authenticated
  with check (private.is_platform_admin());
create policy ai_media_models_update on public.ai_media_models for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy ai_media_models_delete on public.ai_media_models for delete to authenticated
  using (private.is_platform_admin());

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select, insert, delete on public.ai_media_models to authenticated;
grant update (model, display_name, billing_unit, price_micros, price_details, price_currency, price_checked_on,
              price_source, price_verified, data_region, trains_on_inputs, delivery, settings, priority, active, notes)
  on public.ai_media_models to authenticated;
grant select, insert, update, delete on public.ai_media_models to service_role;

revoke all on function private.ai_media_models_stamp() from public, anon, authenticated;

-- ───────────────────────────── Datos de partida ─────────────────────────────
-- Todas las filas nacen INACTIVAS. Precios leídos en la investigación del
-- 16/11/2026 (docs/investigacion-fase2/02-imagen.md y 03-video.md). Solo se
-- marcan como verificados los que esa investigación leyó en la página oficial
-- del propio servicio; el resto queda con `price_verified = false` y su motivo.
-- Lo que la investigación no pudo leer no se siembra.

insert into public.ai_media_models
  (provider, model, task, display_name, billing_unit, price_micros, price_details, price_checked_on, price_source,
   price_verified, data_region, trains_on_inputs, delivery, settings, notes)
values
  ('google-vertex', 'gemini-nano-banana-2.1', 'image', 'Google Nano Banana 2.1 (Vertex AI, UE)', 'image', 33600, '{}',
   '2026-11-16', 'https://aistudio.google.com/docs/pricing', false, 'eu', 'unknown', 'sync', '{}',
   'Precio de la API de Gemini a 1K, no el de Vertex AI: SIN VERIFICAR. La disponibilidad de este modelo en la multirregión UE de Vertex tampoco está confirmada.'),
  ('bfl', 'flux-2-pro', 'image', 'FLUX.2 [pro] (Black Forest Labs)', 'megapixel', 15000,
   '{"first_unit_micros": 30000, "input_megapixel_micros": 15000}',
   '2026-11-16', 'https://bfl.ai/pricing', true, 'eu', 'yes', 'async', '{}',
   'Región UE solo si el adaptador apunta a api.eu.bfl.ai. Sus condiciones le dan licencia sobre entradas y salidas, también para entrenar, salvo contrato enterprise.'),
  ('ideogram', 'ideogram-v3', 'image', 'Ideogram 3.0 (Turbo)', 'image', 30000, '{}',
   '2026-11-16', 'http://ideogram.ai/pricing/?pricing_tab=api', true, 'unknown', 'unknown', 'sync',
   '{"rendering_speed": "TURBO"}',
   'Residencia UE no encontrada. El endpoint v3 figura como heredado en su documentación.'),
  ('higgsfield', 'kling-video/v3.0/std/image-to-video', 'video', 'Kling 3.0 Standard, imagen a vídeo (Higgsfield)', 'second', 112000, '{}',
   '2026-11-16', 'https://higgsfield.ai/blog/higgsfield-api', false, 'unknown', 'yes', 'async',
   '{"fields": {"image": "image_url", "prompt": "prompt", "duration": "duration"}, "static": {"sound": "off"}, "min_seconds": 3, "max_seconds": 15}',
   'SIN VERIFICAR: las dos páginas oficiales dan precios distintos y la ficha del modelo no publica ninguno. Puede entrenar con las entradas (condiciones §4.4). Región de tratamiento no documentada.');
