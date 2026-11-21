-- Fase 4 · Campañas: planes por instrucción («prepara la semana que viene»)
-- que una persona revisa y que un motor determinista convierte en BORRADORES.
-- (docs/02-modelo-de-datos.md y docs/ia-texto.md, tarea `campaign.plan`.)
--
--   * `campaigns` es la campaña: marca, instrucción (dato, nunca órdenes), redes,
--     fechas, de dónde sale el plan (`ai` o `agency`) y su estado:
--       requested  pedida a la agencia, sin plan todavía
--       proposed   hay un plan que revisar
--       accepted   aceptado: sus piezas ya son borradores
--       discarded  descartada (no se creó nada)
--   * `campaign_plans` guarda cada versión del plan (inmutable, numerada): la
--     de la IA o la agencia y, si la persona lo retoca antes de aceptar, la
--     retocada. La columna del plan se llama `data` para que la auditoría no la
--     copie.
--   * `campaign_contents` enlaza la campaña con las piezas que creó el motor y
--     con la versión y la posición del plan de las que salen.
--   * El motor (accept_campaign_plan) solo conoce UNA acción: crear borradores.
--     No aprueba, no programa y no publica; valida el plan entero (forma
--     cerrada, redes de la campaña, fechas dentro del plan, recursos de la
--     propia marca) y cada documento antes de escribir nada. Todo o nada.
--   * Modo agencia: pedir un plan crea un encargo (`content_requests`) de tipo
--     `plan` enlazado a la campaña; la agencia lo toma con el cerrojo de siempre
--     y lo entrega con deliver_campaign_plan; el cliente lo acepta con
--     accept_campaign_plan (como un plan de la IA) o pide cambios con
--     request_content_request_changes.
--   * Nadie escribe estas tablas a mano: solo las funciones de abajo.
--       crear con IA, aceptar, descartar ... edit
--       pedir a la agencia ................. comment (marca en modo agencia)
--       aceptar o descartar un plan de la agencia: edit, o approve
--       entregar (agencia) ................. edit, con el encargo tomado

-- ───────────────────────────── Tipos ─────────────────────────────

create type public.campaign_status as enum ('requested', 'proposed', 'accepted', 'discarded');

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 200),
  -- Lo que pidió la persona, con sus palabras. Es dato, nunca instrucciones.
  instruction text not null check (char_length(btrim(instruction)) between 1 and 2000),
  -- Redes del catálogo de la aplicación (src/features/content/networks.ts).
  networks text[] not null
    check (cardinality(networks) between 1 and 8
           and array_to_string(networks, ',') ~ '^[a-z][a-z0-9_]{0,31}(,[a-z][a-z0-9_]{0,31})*$'),
  starts_on date not null,
  ends_on date not null,
  origin text not null check (origin in ('ai', 'agency')),
  status public.campaign_status not null,
  -- Última versión del plan; 0 = todavía sin plan (pedido a la agencia).
  current_plan_version integer not null default 0 check (current_plan_version >= 0),
  accepted_plan_version integer,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  unique (id, brand_id, organization_id),
  check (ends_on >= starts_on and ends_on - starts_on <= 62),
  check (status = 'requested' or status = 'discarded' or current_plan_version > 0),
  check ((status = 'accepted') = (accepted_plan_version is not null)),
  check (accepted_plan_version is null or accepted_plan_version between 1 and current_plan_version)
);
create index campaigns_brand_created_idx on public.campaigns (brand_id, created_at desc);

create table public.campaign_plans (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  version integer not null check (version > 0),
  -- El plan (forma en src/features/campaigns/plan.ts). Validado por private.campaign_plan_problem.
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 262144),
  -- ai: lo propuso la IA · agency: lo entregó la agencia · edit: lo retocó una persona.
  source text not null check (source in ('ai', 'agency', 'edit')),
  generation_id uuid references public.ai_generations (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (campaign_id, brand_id, organization_id)
    references public.campaigns (id, brand_id, organization_id) on delete cascade,
  unique (campaign_id, version)
);
create index campaign_plans_brand_idx on public.campaign_plans (brand_id);

create table public.campaign_contents (
  campaign_id uuid not null,
  content_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  plan_version integer not null check (plan_version > 0),
  piece_index integer not null check (piece_index >= 0),
  created_at timestamptz not null default now(),
  primary key (campaign_id, content_id),
  foreign key (campaign_id, brand_id, organization_id)
    references public.campaigns (id, brand_id, organization_id) on delete cascade,
  foreign key (content_id, brand_id, organization_id)
    references public.content_items (id, brand_id, organization_id) on delete cascade,
  unique (campaign_id, plan_version, piece_index)
);
create index campaign_contents_content_idx on public.campaign_contents (content_id);
create index campaign_contents_brand_idx on public.campaign_contents (brand_id);

-- ─────────────────── Encargos de tipo «plan» (modo agencia) ───────────────────
-- Lo mínimo sobre content_requests: el tipo, la campaña y la versión del plan
-- entregada. Un encargo de plan no tiene pieza: la regla «entregado ⇒ pieza y
-- versión» pasa a valer solo para los de tipo `piece`.

alter table public.content_requests
  add column kind text not null default 'piece' check (kind in ('piece', 'plan')),
  add column campaign_id uuid,
  add column delivered_plan_version integer check (delivered_plan_version is null or delivered_plan_version > 0),
  add constraint content_requests_campaign_fk foreign key (campaign_id, brand_id, organization_id)
    references public.campaigns (id, brand_id, organization_id) on delete cascade,
  add constraint content_requests_plan_campaign_check check ((kind = 'plan') = (campaign_id is not null)),
  add constraint content_requests_plan_no_piece_check
    check (kind = 'piece' or (content_id is null and delivered_version is null)),
  add constraint content_requests_delivered_plan_check
    check (kind = 'piece' or status not in ('delivered', 'accepted') or delivered_plan_version is not null);

do $$
declare
  v_name text;
begin
  select c.conname into v_name from pg_constraint c
  where c.conrelid = 'public.content_requests'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%(delivered_version IS NOT NULL)%'
    and pg_get_constraintdef(c.oid) like '%content_id IS NOT NULL%';
  if v_name is null then
    raise exception 'No encuentro la regla «entregado ⇒ pieza» de content_requests';
  end if;
  execute format('alter table public.content_requests drop constraint %I', v_name);
end $$;

alter table public.content_requests
  add constraint content_requests_delivered_piece_check
    check (kind = 'plan' or status not in ('delivered', 'accepted')
           or (content_id is not null and delivered_version is not null));

-- Una campaña tiene como mucho un encargo.
create unique index content_requests_campaign_idx on public.content_requests (campaign_id) where campaign_id is not null;

-- ─────────────────────────── Funciones internas ───────────────────────────

-- ¿Es una lista JSON de textos, con tope de elementos y de longitud?
create function private.jsonb_text_list_ok(p_value jsonb, p_max_items integer, p_max_length integer)
returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value), '') = 'array'
     and jsonb_array_length(p_value) <= p_max_items
     and not exists (
       select 1 from jsonb_array_elements(p_value) e(v)
       where jsonb_typeof(e.v) <> 'string' or char_length(e.v #>> '{}') > p_max_length
     );
$$;

-- ¿Es un texto JSON con longitud (sin espacios de los extremos) entre los topes?
create function private.jsonb_text_ok(p_value jsonb, p_min integer, p_max integer)
returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_typeof(p_value), '') = 'string'
     and char_length(btrim(p_value #>> '{}')) between p_min and p_max;
$$;

-- Comprueba un plan contra su campaña. Devuelve el primer problema, o null si
-- el plan es válido. Forma CERRADA: un campo que no esté previsto (por ejemplo
-- «approve», «publish» o «status») invalida el plan entero.
create function private.campaign_plan_problem(p_plan jsonb, p_campaign public.campaigns)
returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_key text;
  v_piece jsonb;
  v_reasoning jsonb;
  v_index integer := 0;
  v_date date;
  v_asset jsonb;
  v_tag jsonb;
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    return 'El plan no tiene el formato esperado';
  end if;
  if pg_column_size(p_plan) > 262144 then
    return 'El plan es demasiado grande';
  end if;
  for v_key in select jsonb_object_keys(p_plan) loop
    if v_key not in ('objective', 'summary', 'reasoning', 'pieces') then
      return format('El plan trae un campo no previsto: «%s»', left(v_key, 40));
    end if;
  end loop;
  if not private.jsonb_text_ok(p_plan -> 'objective', 1, 600) then
    return 'Falta el objetivo del plan (hasta 600 caracteres)';
  end if;
  if not private.jsonb_text_ok(p_plan -> 'summary', 0, 1500) then
    return 'El resumen del plan no es válido (hasta 1.500 caracteres)';
  end if;

  v_reasoning := p_plan -> 'reasoning';
  if coalesce(jsonb_typeof(v_reasoning), '') <> 'object' then
    return 'Falta el razonamiento del plan';
  end if;
  for v_key in select jsonb_object_keys(v_reasoning) loop
    if v_key not in ('observed', 'dataBacked', 'hypotheses', 'dataNote') then
      return format('El razonamiento trae un campo no previsto: «%s»', left(v_key, 40));
    end if;
  end loop;
  if not (private.jsonb_text_list_ok(v_reasoning -> 'observed', 10, 400)
          and private.jsonb_text_list_ok(v_reasoning -> 'dataBacked', 10, 400)
          and private.jsonb_text_list_ok(v_reasoning -> 'hypotheses', 20, 400)
          and private.jsonb_text_ok(v_reasoning -> 'dataNote', 0, 600)) then
    return 'El razonamiento debe separar lo observado, lo respaldado por datos y las hipótesis (listas de textos breves) y llevar la nota sobre los datos';
  end if;

  if coalesce(jsonb_typeof(p_plan -> 'pieces'), '') <> 'array'
     or jsonb_array_length(p_plan -> 'pieces') not between 1 and 30 then
    return 'El plan debe tener entre 1 y 30 piezas';
  end if;

  for v_piece in select e.v from jsonb_array_elements(p_plan -> 'pieces') e(v) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_piece) <> 'object' then
      return format('La pieza %s no tiene el formato esperado', v_index);
    end if;
    for v_key in select jsonb_object_keys(v_piece) loop
      if v_key not in ('network', 'format', 'date', 'idea', 'caption', 'hashtags', 'assetIds', 'why') then
        return format('La pieza %s trae un campo no previsto: «%s»', v_index, left(v_key, 40));
      end if;
    end loop;
    if coalesce(jsonb_typeof(v_piece -> 'network'), '') <> 'string'
       or not ((v_piece ->> 'network') = any (p_campaign.networks)) then
      return format('La pieza %s va a una red que no es de la campaña', v_index);
    end if;
    if coalesce(jsonb_typeof(v_piece -> 'format'), '') <> 'string'
       or (v_piece ->> 'format') !~ '^[a-z][a-z0-9_]{0,31}$' then
      return format('La pieza %s no tiene un formato válido', v_index);
    end if;
    if coalesce(jsonb_typeof(v_piece -> 'date'), '') <> 'string'
       or (v_piece ->> 'date') !~ '^\d{4}-\d{2}-\d{2}$' then
      return format('La pieza %s no tiene una fecha válida', v_index);
    end if;
    begin
      v_date := (v_piece ->> 'date')::date;
    exception when others then
      return format('La pieza %s no tiene una fecha válida', v_index);
    end;
    if v_date < p_campaign.starts_on or v_date > p_campaign.ends_on then
      return format('La pieza %s cae fuera de las fechas de la campaña', v_index);
    end if;
    if not private.jsonb_text_ok(v_piece -> 'idea', 1, 300) then
      return format('La pieza %s necesita una idea (hasta 300 caracteres)', v_index);
    end if;
    if not private.jsonb_text_ok(v_piece -> 'caption', 1, 5000) then
      return format('La pieza %s necesita un texto (hasta 5.000 caracteres)', v_index);
    end if;
    if not private.jsonb_text_ok(v_piece -> 'why', 0, 600) then
      return format('La explicación de la pieza %s no es válida (hasta 600 caracteres)', v_index);
    end if;
    if not private.jsonb_text_list_ok(v_piece -> 'hashtags', 30, 100) then
      return format('Las etiquetas de la pieza %s no son válidas (hasta 30)', v_index);
    end if;
    for v_tag in select e.v from jsonb_array_elements(v_piece -> 'hashtags') e(v) loop
      if (v_tag #>> '{}') = '' or (v_tag #>> '{}') ~ '[[:space:]#]' then
        return format('Las etiquetas de la pieza %s van sin # y sin espacios', v_index);
      end if;
    end loop;
    if not private.jsonb_text_list_ok(v_piece -> 'assetIds', 4, 36) then
      return format('Los recursos de la pieza %s no son válidos (hasta 4)', v_index);
    end if;
    for v_asset in select e.v from jsonb_array_elements(v_piece -> 'assetIds') e(v) loop
      if (v_asset #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         or not exists (
           select 1 from public.media_assets m
           where m.id = (v_asset #>> '{}')::uuid and m.brand_id = p_campaign.brand_id
         ) then
        return format('La pieza %s sugiere un recurso que no es de esta marca', v_index);
      end if;
    end loop;
  end loop;
  return null;
end $$;

-- Valida los datos comunes de una campaña nueva. Lanza 22023 con el motivo.
create function private.campaign_check_input(
  p_title text, p_instruction text, p_networks text[], p_starts_on date, p_ends_on date
) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200 then
    raise exception 'La campaña necesita un nombre (hasta 200 caracteres)' using errcode = '22023';
  end if;
  if char_length(btrim(coalesce(p_instruction, ''))) not between 1 and 2000 then
    raise exception 'Escribe qué quieres preparar (hasta 2.000 caracteres)' using errcode = '22023';
  end if;
  if p_networks is null or cardinality(p_networks) not between 1 and 8
     or array_to_string(p_networks, ',') !~ '^[a-z][a-z0-9_]{0,31}(,[a-z][a-z0-9_]{0,31})*$' then
    raise exception 'Elige entre 1 y 8 redes' using errcode = '22023';
  end if;
  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on or p_ends_on - p_starts_on > 62 then
    raise exception 'Las fechas no son válidas: el plan dura de 1 a 63 días' using errcode = '22023';
  end if;
end $$;

-- Guarda una versión nueva del plan y la deja como vigente.
create function private.campaign_add_plan(
  p_campaign public.campaigns, p_plan jsonb, p_source text, p_generation_id uuid
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_version integer := p_campaign.current_plan_version + 1;
begin
  insert into public.campaign_plans (campaign_id, brand_id, organization_id, version, data, source, generation_id,
                                     created_by)
  values (p_campaign.id, p_campaign.brand_id, p_campaign.organization_id, v_version, p_plan, p_source,
          p_generation_id, (select auth.uid()));
  return v_version;
end $$;

-- Bloquea la campaña y comprueba que el usuario puede decidir sobre ella
-- (aceptar o descartar): quien edita la marca y, si el plan es de la agencia,
-- también quien aprueba. Sin permiso (o si no existe) falla con 42501.
create function private.campaign_lock_for_decision(p_campaign_id uuid)
returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_campaign public.campaigns;
begin
  select * into v_campaign from public.campaigns c
  where c.id = p_campaign_id
    and (c.brand_id in (select private.brand_ids_with('edit'))
         or (c.origin = 'agency' and c.brand_id in (select private.brand_ids_with('approve'))))
  for update;
  if not found then
    raise exception 'No tienes permiso para decidir sobre esta campaña' using errcode = '42501';
  end if;
  return v_campaign;
end $$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Guarda una campaña con el plan que acaba de proponer la IA (`campaign.plan`
-- en ai-generate). La generación debe ser de esta marca, de esta persona, de
-- esa tarea y haber terminado bien. El plan queda «propuesto»: nada más.
create function public.create_campaign(
  p_brand_id uuid,
  p_title text,
  p_instruction text,
  p_networks text[],
  p_starts_on date,
  p_ends_on date,
  p_plan jsonb,
  p_generation_id uuid
) returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_brand public.brands;
  v_campaign public.campaigns;
  v_problem text;
begin
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.id in (select private.brand_ids_with('edit'));
  if not found then
    raise exception 'No tienes permiso para preparar campañas en esta marca' using errcode = '42501';
  end if;
  perform private.campaign_check_input(p_title, p_instruction, p_networks, p_starts_on, p_ends_on);
  if p_generation_id is null or not exists (
    select 1 from public.ai_generations g
    where g.id = p_generation_id and g.brand_id = v_brand.id and g.purpose = 'campaign.plan'
      and g.status = 'succeeded' and g.requested_by = (select auth.uid())
  ) then
    raise exception 'Ese plan no sale de una generación de esta marca' using errcode = '22023';
  end if;

  insert into public.campaigns (brand_id, organization_id, title, instruction, networks, starts_on, ends_on, origin,
                                status, current_plan_version, created_by)
  values (v_brand.id, v_brand.organization_id, btrim(p_title), btrim(p_instruction),
          array(select distinct unnest(p_networks) order by 1), p_starts_on, p_ends_on, 'ai',
          'proposed', 1, (select auth.uid()))
  returning * into v_campaign;

  v_problem := private.campaign_plan_problem(p_plan, v_campaign);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  insert into public.campaign_plans (campaign_id, brand_id, organization_id, version, data, source, generation_id,
                                     created_by)
  values (v_campaign.id, v_campaign.brand_id, v_campaign.organization_id, 1, p_plan, 'ai', p_generation_id,
          (select auth.uid()));
  return v_campaign;
end $$;

-- Pide el plan a la agencia (marca en modo agencia). Crea la campaña sin plan
-- y un encargo de tipo «plan» enlazado, que la agencia ve en su cola.
create function public.request_campaign_plan(
  p_brand_id uuid,
  p_title text,
  p_instruction text,
  p_networks text[],
  p_starts_on date,
  p_ends_on date
) returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_brand public.brands;
  v_campaign public.campaigns;
  v_request public.content_requests;
  v_networks text[];
begin
  select * into v_brand from public.brands b
  where b.id = p_brand_id and b.id in (select private.brand_ids_with('comment'));
  if not found then
    raise exception 'No tienes permiso para pedir planes en esta marca' using errcode = '42501';
  end if;
  if v_brand.ai_mode <> 'agency' then
    raise exception 'Esta marca no trabaja con la agencia: el plan se prepara con la IA' using errcode = 'P0001';
  end if;
  perform private.campaign_check_input(p_title, p_instruction, p_networks, p_starts_on, p_ends_on);
  v_networks := array(select distinct unnest(p_networks) order by 1);

  insert into public.campaigns (brand_id, organization_id, title, instruction, networks, starts_on, ends_on, origin,
                                status, created_by)
  values (v_brand.id, v_brand.organization_id, btrim(p_title), btrim(p_instruction), v_networks, p_starts_on,
          p_ends_on, 'agency', 'requested', (select auth.uid()))
  returning * into v_campaign;

  -- Red del encargo: la primera de la campaña (la lista completa va en la campaña).
  -- Formato «plan»: no es una pieza del catálogo.
  insert into public.content_requests (brand_id, organization_id, title, brief, network, format, desired_date,
                                       requested_by, kind, campaign_id)
  values (v_brand.id, v_brand.organization_id, left('Plan: ' || btrim(p_title), 200),
          btrim(p_instruction) || E'\n\n— Plan del ' || to_char(p_starts_on, 'DD/MM/YYYY') || ' al '
            || to_char(p_ends_on, 'DD/MM/YYYY') || ' para: ' || array_to_string(v_networks, ', ') || '.',
          v_networks[1], 'plan', p_starts_on, (select auth.uid()), 'plan', v_campaign.id)
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'requested', '');
  return v_campaign;
end $$;

-- La agencia entrega el plan de un encargo de tipo «plan» que tiene tomado.
-- El plan se valida igual que el de la IA; la campaña queda «propuesta».
create function public.deliver_campaign_plan(
  p_request_id uuid,
  p_plan jsonb,
  p_claim_token text default null,
  p_note text default null
) returns public.content_requests
language plpgsql security definer set search_path = '' as $$
declare
  v_request public.content_requests;
  v_campaign public.campaigns;
  v_problem text;
  v_version integer;
  v_note text := coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'Plan entregado por la agencia');
begin
  v_request := private.content_request_lock(p_request_id, 'edit', 'No tienes permiso para entregar este encargo');
  if v_request.kind <> 'plan' then
    raise exception 'Este encargo es de una pieza: entrégalo con deliver_content_request' using errcode = 'P0001';
  end if;
  if v_request.status <> 'in_progress' then
    raise exception 'Solo se entrega un encargo en curso: tómalo antes' using errcode = 'P0001';
  end if;
  if private.content_request_claimed_by_other(v_request, p_claim_token) then
    raise exception 'Este encargo lo tiene otra persona u otra sesión' using errcode = 'RQ001';
  end if;
  select * into v_campaign from public.campaigns c where c.id = v_request.campaign_id for update;
  if v_campaign.status not in ('requested', 'proposed') then
    raise exception 'La campaña ya está cerrada' using errcode = 'P0001';
  end if;
  v_problem := private.campaign_plan_problem(p_plan, v_campaign);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;

  v_version := private.campaign_add_plan(v_campaign, p_plan, 'agency', null);
  update public.campaigns c set status = 'proposed', current_plan_version = v_version where c.id = v_campaign.id;
  update public.content_requests r
  set status = 'delivered', delivered_plan_version = v_version, delivered_by = (select auth.uid()),
      delivered_at = now(), claimed_by = null, claim_token = null, claimed_until = null
  where r.id = v_request.id
  returning * into v_request;
  perform private.content_request_log(v_request, 'status', 'delivered', v_note);
  return v_request;
end $$;

-- EL MOTOR. Acepta el plan (tal como lo deja la persona tras revisarlo) y crea
-- sus piezas como BORRADORES, todo en una transacción:
--   * p_expected_version: la versión del plan que se revisó; si hay otra, CP001.
--   * p_plan: el plan revisado (sin piezas quitadas, con lo retocado). Si
--     difiere del vigente se guarda como versión nueva («edit»).
--   * p_drafts: un documento por pieza, en el mismo orden: {title, schemaVersion, data}.
--     Red y formato salen de la pieza, no del borrador. El texto del documento
--     debe ser el de la pieza.
-- Única acción posible: crear piezas en estado «borrador» con su versión 1.
-- Nunca aprueba, programa ni publica.
create function public.accept_campaign_plan(
  p_campaign_id uuid,
  p_expected_version integer,
  p_plan jsonb,
  p_drafts jsonb
) returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_campaign public.campaigns;
  v_request public.content_requests;
  v_problem text;
  v_version integer;
  v_piece jsonb;
  v_draft jsonb;
  v_index integer;
  v_title text;
  v_schema integer;
  v_content_id uuid;
begin
  v_campaign := private.campaign_lock_for_decision(p_campaign_id);
  if v_campaign.status <> 'proposed' then
    raise exception 'Esta campaña no tiene un plan pendiente de aceptar' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version <> v_campaign.current_plan_version then
    raise exception 'El plan ha cambiado desde que lo abriste. Vuelve a abrirlo antes de aceptar.'
      using errcode = 'CP001',
            detail = jsonb_build_object('current_version', v_campaign.current_plan_version,
                                        'expected_version', p_expected_version)::text;
  end if;
  if v_campaign.origin = 'agency' then
    select * into v_request from public.content_requests r where r.campaign_id = v_campaign.id for update;
    if not found or v_request.status <> 'delivered' then
      raise exception 'La agencia está preparando cambios en este plan: espera a la entrega nueva' using errcode = 'P0001';
    end if;
  end if;

  v_problem := private.campaign_plan_problem(p_plan, v_campaign);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_drafts), '') <> 'array'
     or jsonb_array_length(p_drafts) <> jsonb_array_length(p_plan -> 'pieces') then
    raise exception 'Hace falta un borrador por cada pieza del plan' using errcode = '22023';
  end if;

  -- El plan revisado: si la persona lo ha retocado, es una versión nueva.
  v_version := v_campaign.current_plan_version;
  if p_plan is distinct from (
    select p.data from public.campaign_plans p where p.campaign_id = v_campaign.id and p.version = v_version
  ) then
    v_version := private.campaign_add_plan(v_campaign, p_plan, 'edit', null);
  end if;

  for v_index in 0 .. jsonb_array_length(p_drafts) - 1 loop
    v_piece := p_plan -> 'pieces' -> v_index;
    v_draft := p_drafts -> v_index;
    if coalesce(jsonb_typeof(v_draft), '') <> 'object'
       or exists (select 1 from jsonb_object_keys(v_draft) k where k not in ('title', 'schemaVersion', 'data')) then
      raise exception 'El borrador % no tiene el formato esperado', v_index + 1 using errcode = '22023';
    end if;
    v_title := btrim(coalesce(v_draft ->> 'title', ''));
    if char_length(v_title) not between 1 and 200 then
      raise exception 'El borrador % necesita un título (hasta 200 caracteres)', v_index + 1 using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(v_draft -> 'schemaVersion'), '') <> 'number'
       or (v_draft ->> 'schemaVersion') !~ '^[1-9][0-9]{0,3}$' then
      raise exception 'El borrador % no indica la versión de su documento', v_index + 1 using errcode = '22023';
    end if;
    v_schema := (v_draft ->> 'schemaVersion')::integer;
    if coalesce(jsonb_typeof(v_draft -> 'data'), '') <> 'object'
       or pg_column_size(v_draft -> 'data') > 524288
       or (v_draft -> 'data' ->> 'schemaVersion') is distinct from (v_draft ->> 'schemaVersion') then
      raise exception 'El documento del borrador % no es válido', v_index + 1 using errcode = '22023';
    end if;
    if (v_draft -> 'data' -> 'copy' ->> 'caption') is distinct from (v_piece ->> 'caption') then
      raise exception 'El texto del borrador % no es el de su pieza del plan', v_index + 1 using errcode = '22023';
    end if;

    -- Pieza nueva y su primera versión. Se escribe aquí y no con
    -- private.content_write_version porque, en un plan de la agencia, puede
    -- aceptarlo quien solo aprueba; el resultado es el mismo: versión 1 y borrador.
    insert into public.content_items (brand_id, organization_id, title, network, format, created_by)
    values (v_campaign.brand_id, v_campaign.organization_id, v_title, v_piece ->> 'network', v_piece ->> 'format',
            (select auth.uid()))
    returning id into v_content_id;
    insert into public.content_versions (content_id, brand_id, organization_id, version, schema_version, data,
                                         change_note, created_by)
    values (v_content_id, v_campaign.brand_id, v_campaign.organization_id, 1, v_schema, v_draft -> 'data',
            left('Borrador creado desde el plan de la campaña «' || v_campaign.title || '»', 500), (select auth.uid()));
    update public.content_items c set current_version = 1, status = 'draft' where c.id = v_content_id;
    insert into public.campaign_contents (campaign_id, content_id, brand_id, organization_id, plan_version,
                                          piece_index)
    values (v_campaign.id, v_content_id, v_campaign.brand_id, v_campaign.organization_id, v_version, v_index);
  end loop;

  update public.campaigns c
  set status = 'accepted', current_plan_version = v_version, accepted_plan_version = v_version,
      accepted_by = (select auth.uid()), accepted_at = now()
  where c.id = v_campaign.id
  returning * into v_campaign;

  if v_request.id is not null then
    update public.content_requests r
    set status = 'accepted', accepted_by = (select auth.uid()), accepted_at = now()
    where r.id = v_request.id
    returning * into v_request;
    perform private.content_request_log(v_request, 'status', 'accepted', 'Plan aceptado: sus piezas son borradores');
  end if;
  return v_campaign;
end $$;

-- Descarta una campaña que no está aceptada. Si había un encargo a la agencia
-- abierto, se cancela. No se borra nada.
create function public.discard_campaign(p_campaign_id uuid, p_reason text default '')
returns public.campaigns
language plpgsql security definer set search_path = '' as $$
declare
  v_campaign public.campaigns;
  v_request public.content_requests;
begin
  v_campaign := private.campaign_lock_for_decision(p_campaign_id);
  if v_campaign.status not in ('requested', 'proposed') then
    raise exception 'Esta campaña ya está cerrada' using errcode = 'P0001';
  end if;
  update public.campaigns c set status = 'discarded' where c.id = v_campaign.id returning * into v_campaign;
  update public.content_requests r
  set status = 'cancelled', claimed_by = null, claim_token = null, claimed_until = null
  where r.campaign_id = v_campaign.id and r.status not in ('accepted', 'cancelled')
  returning * into v_request;
  if v_request.id is not null then
    perform private.content_request_log(v_request, 'status', 'cancelled',
                                        coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'Campaña descartada'));
  end if;
  return v_campaign;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

-- Un encargo de plan no admite las acciones de pieza (entregar una pieza o
-- aceptarla con accept_content_request): sus caminos son deliver_campaign_plan
-- y accept_campaign_plan.
create function private.content_requests_plan_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'plan' and (new.content_id is not null or new.delivered_version is not null) then
    raise exception 'Este encargo es un plan de campaña: se entrega con deliver_campaign_plan' using errcode = 'P0001';
  end if;
  if new.kind <> old.kind or new.campaign_id is distinct from old.campaign_id then
    raise exception 'El tipo y la campaña de un encargo no cambian' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- Cancelar el encargo de un plan (cancel_content_request) descarta su campaña.
create function private.content_requests_plan_cancelled() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.campaigns c set status = 'discarded'
  where c.id = new.campaign_id and c.status in ('requested', 'proposed');
  return null;
end $$;

create trigger content_requests_plan_guard before update on public.content_requests
  for each row execute function private.content_requests_plan_guard();
create trigger content_requests_plan_cancelled after update of status on public.content_requests
  for each row when (new.kind = 'plan' and new.status = 'cancelled' and old.status <> 'cancelled')
  execute function private.content_requests_plan_cancelled();

create trigger campaigns_touch before update on public.campaigns
  for each row execute function private.touch_updated_at();

-- Auditoría: alta, cambios de estado y borrado de la campaña; alta de cada
-- versión del plan (sin el plan).
create trigger campaigns_audit after insert or update of status or delete on public.campaigns
  for each row execute function private.audit();
create trigger campaign_plans_audit after insert on public.campaign_plans
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.campaigns enable row level security;
alter table public.campaign_plans enable row level security;
alter table public.campaign_contents enable row level security;

-- Ve las campañas, sus planes y sus piezas quien ve la marca. Sin políticas de
-- escritura: se escribe solo con las funciones de arriba.
create policy campaigns_select on public.campaigns for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy campaign_plans_select on public.campaign_plans for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy campaign_contents_select on public.campaign_contents for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────

grant select on public.campaigns, public.campaign_plans, public.campaign_contents to authenticated, service_role;

revoke all on function private.jsonb_text_list_ok(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.jsonb_text_ok(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function private.campaign_plan_problem(jsonb, public.campaigns) from public, anon, authenticated;
revoke all on function private.campaign_check_input(text, text, text[], date, date) from public, anon, authenticated;
revoke all on function private.campaign_add_plan(public.campaigns, jsonb, text, uuid) from public, anon, authenticated;
revoke all on function private.campaign_lock_for_decision(uuid) from public, anon, authenticated;
revoke all on function private.content_requests_plan_guard() from public, anon, authenticated;
revoke all on function private.content_requests_plan_cancelled() from public, anon, authenticated;

revoke all on function public.create_campaign(uuid, text, text, text[], date, date, jsonb, uuid)
  from public, anon, authenticated;
revoke all on function public.request_campaign_plan(uuid, text, text, text[], date, date)
  from public, anon, authenticated;
revoke all on function public.deliver_campaign_plan(uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.accept_campaign_plan(uuid, integer, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.discard_campaign(uuid, text) from public, anon, authenticated;

grant execute on function public.create_campaign(uuid, text, text, text[], date, date, jsonb, uuid) to authenticated;
grant execute on function public.request_campaign_plan(uuid, text, text, text[], date, date) to authenticated;
grant execute on function public.deliver_campaign_plan(uuid, jsonb, text, text) to authenticated;
grant execute on function public.accept_campaign_plan(uuid, integer, jsonb, jsonb) to authenticated;
grant execute on function public.discard_campaign(uuid, text) to authenticated;
