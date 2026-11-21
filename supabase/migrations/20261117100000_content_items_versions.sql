-- Fase 2 · Contenidos: las publicaciones de una marca y las versiones de su
-- documento (docs/02-modelo-de-datos.md, «Contenidos y versiones»).
--
--   * `content_items` es la pieza: a qué red y formato va, en qué estado está
--     (de idea a aprobada) y quién la creó. `content_versions` guarda el
--     documento: cada guardado es una fila nueva, numerada, con nota y autor.
--   * Las versiones son inmutables. Nadie las cambia ni las borra, tampoco con
--     la clave de servicio; restaurar una antigua crea una versión nueva.
--   * Guardar exige permiso de edición sobre la marca y bloquea la fila de la
--     pieza: dos guardados simultáneos no pueden repetir número. Quien guarda
--     puede indicar sobre qué versión trabajaba; si otra persona guardó antes,
--     falla con CT001 en vez de pisar su trabajo.
--   * Una aprobación vale para la versión que se aprobó: guardar otra versión o
--     cambiar la red o el formato devuelve la pieza a borrador.
--   * El documento es un JSON validado en el cliente (`schema_version`), igual
--     que el perfil de marca. La columna se llama `data` como allí: el registro
--     de auditoría no copia esa columna.
--   * `network` y `format` son texto con formato de identificador: qué redes y
--     formatos existen es un catálogo de la aplicación, no de esta tabla.
--   * Aquí no hay programación ni publicación (Fase 3): el estado acaba en
--     «aprobada». Las claves únicas (id, brand_id, organization_id) y
--     (content_id, version) son el destino de las claves foráneas que usarán
--     las publicaciones programadas para fijar pieza y versión aprobada.

-- ───────────────────────────── Tipos ─────────────────────────────

-- idea: apuntada, quizá sin documento · draft: en preparación ·
-- in_review: pendiente de quien aprueba · approved: la versión vigente está aprobada.
create type public.content_status as enum ('idea', 'draft', 'in_review', 'approved');

-- ───────────────────────────── Tablas ─────────────────────────────

create table public.content_items (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  organization_id uuid not null,
  -- Nombre interno de la pieza; no se publica.
  title text not null check (char_length(btrim(title)) between 1 and 200),
  network text not null check (network ~ '^[a-z][a-z0-9_]{0,31}$'),
  format text not null check (format ~ '^[a-z][a-z0-9_]{0,31}$'),
  status public.content_status not null default 'idea',
  -- Número de la última versión guardada; 0 = todavía no tiene documento.
  current_version integer not null default 0 check (current_version >= 0),
  -- Archivada: sale de las listas y no admite cambios hasta recuperarla.
  archived_at timestamptz,
  created_by uuid references auth.users (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (brand_id, organization_id) references public.brands (id, organization_id) on delete cascade,
  -- Destino de las claves foráneas compuestas de las tablas hijas.
  unique (id, brand_id, organization_id),
  -- No se revisa ni se aprueba lo que no tiene documento.
  check (status in ('idea', 'draft') or current_version > 0)
);
create index content_items_brand_updated_idx on public.content_items (brand_id, updated_at desc);

create table public.content_versions (
  id uuid primary key default gen_random_uuid(),
  content_id uuid not null,
  brand_id uuid not null,
  organization_id uuid not null,
  version integer not null check (version > 0),
  schema_version integer not null check (schema_version > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 524288),
  change_note text not null default '' check (char_length(change_note) <= 500),
  -- Si esta versión es una restauración, de cuál se copió.
  restored_from integer check (restored_from is null or (restored_from > 0 and restored_from < version)),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Una versión no puede declararse de otra marca u organización que su pieza.
  foreign key (content_id, brand_id, organization_id)
    references public.content_items (id, brand_id, organization_id) on delete cascade,
  unique (content_id, version)
);
create index content_versions_brand_created_idx on public.content_versions (brand_id, created_at desc);

-- ─────────────────────────── Funciones internas ───────────────────────────

-- Cambiar la red o el formato de una pieza aprobada le retira la aprobación:
-- lo que se aprobó era otra cosa.
create function private.content_items_retarget() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'approved' and (new.network, new.format) is distinct from (old.network, old.format) then
    new.status := 'draft';
  end if;
  return new;
end $$;

-- Añade una versión a una pieza. Es el único sitio donde se escribe
-- content_versions; lo usan guardar y restaurar.
--   42501  sin permiso de edición sobre la marca (o la pieza no existe)
--   CT001  la pieza ya tiene una versión posterior a la esperada (DETAIL: JSON)
create function private.content_write_version(
  p_content_id uuid,
  p_data jsonb,
  p_schema_version integer,
  p_change_note text,
  p_expected_version integer,
  p_restored_from integer
) returns public.content_versions
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.content_items;
  v_data jsonb := p_data;
  v_schema integer := p_schema_version;
  v_version public.content_versions;
begin
  -- El bloqueo de la pieza serializa los guardados simultáneos.
  select * into v_item from public.content_items c
  where c.id = p_content_id and c.brand_id in (select private.brand_ids_with('edit'))
  for update;
  if not found then
    raise exception 'No tienes permiso para editar este contenido' using errcode = '42501';
  end if;
  if v_item.archived_at is not null then
    raise exception 'El contenido está archivado: recupéralo antes de cambiarlo' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and p_expected_version <> v_item.current_version then
    raise exception 'Otra persona ha guardado una versión más reciente de este contenido. Vuelve a abrirlo antes de guardar.'
      using errcode = 'CT001',
            detail = jsonb_build_object(
              'current_version', v_item.current_version, 'expected_version', p_expected_version)::text;
  end if;

  if p_restored_from is not null then
    select v.data, v.schema_version into v_data, v_schema
    from public.content_versions v
    where v.content_id = v_item.id and v.version = p_restored_from;
    if not found then
      raise exception 'Esa versión no existe' using errcode = 'P0001';
    end if;
  end if;
  if v_data is null or jsonb_typeof(v_data) <> 'object' or v_schema is null or v_schema < 1 then
    raise exception 'El documento no es válido' using errcode = '22023';
  end if;

  insert into public.content_versions (content_id, brand_id, organization_id, version, schema_version, data,
                                       change_note, restored_from, created_by)
  values (v_item.id, v_item.brand_id, v_item.organization_id, v_item.current_version + 1, v_schema, v_data,
          left(coalesce(p_change_note, ''), 500), p_restored_from, (select auth.uid()))
  returning * into v_version;

  -- Una idea con documento ya es un borrador, y una aprobación no cubre la
  -- versión nueva. Dos sentencias distintas: solo el cambio de estado se audita.
  if v_item.status in ('idea', 'approved') then
    update public.content_items c set current_version = v_version.version, status = 'draft' where c.id = v_item.id;
  else
    update public.content_items c set current_version = v_version.version where c.id = v_item.id;
  end if;

  return v_version;
end $$;

-- ──────────────────────────── RPC para personas ────────────────────────────

-- Guarda el documento como versión nueva. Con p_expected_version, falla (CT001)
-- si la pieza ya no está en esa versión.
create function public.save_content_version(
  p_content_id uuid,
  p_data jsonb,
  p_schema_version integer,
  p_change_note text default '',
  p_expected_version integer default null
) returns public.content_versions
language plpgsql security definer set search_path = '' as $$
begin
  return private.content_write_version(p_content_id, p_data, p_schema_version, p_change_note, p_expected_version, null);
end $$;

-- Restaura una versión anterior: copia su documento en una versión nueva. El
-- historial no se toca.
create function public.restore_content_version(
  p_content_id uuid,
  p_version integer,
  p_change_note text default '',
  p_expected_version integer default null
) returns public.content_versions
language plpgsql security definer set search_path = '' as $$
begin
  if p_version is null then
    raise exception 'Indica qué versión quieres restaurar' using errcode = '22023';
  end if;
  return private.content_write_version(p_content_id, null, null, p_change_note, p_expected_version, p_version);
end $$;

-- Cambia el estado de una pieza.
--   * Quien edita la marca la mueve entre idea, borrador y revisión, y puede
--     retirar una aprobación.
--   * Aprobar exige la capacidad de aprobar, que la pieza esté en revisión (o en
--     borrador, si quien aprueba también edita) y decir qué versión se aprueba:
--     si entretanto se guardó otra, falla con CT001.
--   * Quien solo aprueba puede devolver a borrador lo que está en revisión o
--     aprobado; nada más.
create function public.set_content_status(
  p_content_id uuid,
  p_status public.content_status,
  p_expected_version integer default null
) returns public.content_items
language plpgsql security definer set search_path = '' as $$
declare
  v_brand uuid;
  v_can_edit boolean;
  v_can_approve boolean;
  v_item public.content_items;
begin
  select c.brand_id into v_brand from public.content_items c where c.id = p_content_id;
  v_can_edit := coalesce(v_brand in (select private.brand_ids_with('edit')), false);
  v_can_approve := coalesce(v_brand in (select private.brand_ids_with('approve')), false);
  if not (v_can_edit or v_can_approve) then
    raise exception 'No tienes permiso para cambiar el estado de este contenido' using errcode = '42501';
  end if;
  if p_status is null then
    raise exception 'Indica el estado nuevo' using errcode = '22023';
  end if;

  select * into v_item from public.content_items c where c.id = p_content_id for update;
  if v_item.archived_at is not null then
    raise exception 'El contenido está archivado: recupéralo antes de cambiarlo' using errcode = 'P0001';
  end if;
  if p_expected_version is not null and p_expected_version <> v_item.current_version then
    raise exception 'Otra persona ha guardado una versión más reciente de este contenido. Vuelve a abrirlo antes de continuar.'
      using errcode = 'CT001',
            detail = jsonb_build_object(
              'current_version', v_item.current_version, 'expected_version', p_expected_version)::text;
  end if;
  if p_status = v_item.status then
    return v_item;
  end if;

  if p_status = 'approved' then
    if not v_can_approve then
      raise exception 'No tienes permiso para aprobar este contenido' using errcode = '42501';
    end if;
    if not (v_item.status = 'in_review' or (v_can_edit and v_item.status = 'draft')) then
      raise exception 'Solo se puede aprobar un contenido que está en revisión' using errcode = 'P0001';
    end if;
    if p_expected_version is null then
      raise exception 'Indica qué versión apruebas' using errcode = '22023';
    end if;
  elsif not v_can_edit and not (p_status = 'draft' and v_item.status in ('in_review', 'approved')) then
    raise exception 'No tienes permiso para cambiar el estado de este contenido' using errcode = '42501';
  end if;
  if p_status in ('in_review', 'approved') and v_item.current_version = 0 then
    raise exception 'El contenido todavía no tiene ningún documento guardado' using errcode = 'P0001';
  end if;

  update public.content_items c set status = p_status where c.id = v_item.id returning * into v_item;
  return v_item;
end $$;

-- Archiva una pieza o la recupera (p_archived = false). No se borra nada.
create function public.archive_content_item(p_content_id uuid, p_archived boolean default true)
returns public.content_items
language plpgsql security definer set search_path = '' as $$
declare
  v_item public.content_items;
begin
  select * into v_item from public.content_items c
  where c.id = p_content_id and c.brand_id in (select private.brand_ids_with('edit'))
  for update;
  if not found then
    raise exception 'No tienes permiso para archivar este contenido' using errcode = '42501';
  end if;
  if coalesce(p_archived, true) = (v_item.archived_at is not null) then
    return v_item;
  end if;

  update public.content_items c
  set archived_at = case when coalesce(p_archived, true) then now() end
  where c.id = v_item.id
  returning * into v_item;
  return v_item;
end $$;

-- ─────────────────────────── Disparadores ───────────────────────────

create trigger content_items_touch before update on public.content_items
  for each row execute function private.touch_updated_at();
create trigger content_items_retarget before update of network, format on public.content_items
  for each row execute function private.content_items_retarget();

-- Auditoría como el resto de tablas. De la pieza se registran el alta, el
-- borrado y los cambios que importan (no el avance del número de versión, que
-- ya deja su propia fila); de las versiones, el alta, sin el documento.
create trigger content_items_audit
  after insert or update of title, network, format, status, archived_at or delete on public.content_items
  for each row execute function private.audit();
create trigger content_versions_audit after insert on public.content_versions
  for each row execute function private.audit();

-- ───────────────────────── Seguridad a nivel de fila ─────────────────────────

alter table public.content_items enable row level security;
alter table public.content_versions enable row level security;

-- Ve los contenidos quien ve la marca; los crea y los retoca quien la edita.
-- Una pieza archivada no se retoca (ni siquiera el título).
create policy content_items_select on public.content_items for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));
create policy content_items_insert on public.content_items for insert to authenticated
  with check (brand_id in (select private.brand_ids_with('edit')) and created_by = (select auth.uid()));
create policy content_items_update on public.content_items for update to authenticated
  using (brand_id in (select private.brand_ids_with('edit')) and archived_at is null)
  with check (brand_id in (select private.brand_ids_with('edit')));

-- content_versions: solo lectura; se escribe con save_content_version() y
-- restore_content_version().
create policy content_versions_select on public.content_versions for select to authenticated
  using (brand_id in (select private.brand_ids_with('view')));

-- ───────────────────────────── Privilegios ─────────────────────────────
-- El cliente crea la pieza y cambia su título, red y formato. El estado, el
-- número de versión y el archivado solo cambian por función. Las versiones no
-- las escribe nadie a mano: ni el cliente ni la clave de servicio.

grant select on public.content_items, public.content_versions to authenticated, service_role;
grant insert (brand_id, organization_id, title, network, format) on public.content_items to authenticated;
grant update (title, network, format) on public.content_items to authenticated;

revoke all on function private.content_items_retarget() from public, anon, authenticated;
revoke all on function private.content_write_version(uuid, jsonb, integer, text, integer, integer) from public, anon, authenticated;

revoke all on function public.save_content_version(uuid, jsonb, integer, text, integer) from public, anon, authenticated;
revoke all on function public.restore_content_version(uuid, integer, text, integer) from public, anon, authenticated;
revoke all on function public.set_content_status(uuid, public.content_status, integer) from public, anon, authenticated;
revoke all on function public.archive_content_item(uuid, boolean) from public, anon, authenticated;

grant execute on function public.save_content_version(uuid, jsonb, integer, text, integer) to authenticated;
grant execute on function public.restore_content_version(uuid, integer, text, integer) to authenticated;
grant execute on function public.set_content_status(uuid, public.content_status, integer) to authenticated;
grant execute on function public.archive_content_item(uuid, boolean) to authenticated;
