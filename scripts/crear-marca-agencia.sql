-- Crea una marca en MODO AGENCIA (`brands.ai_mode = 'agency'`) dentro de una
-- organización que ya existe, y le da las mismas personas y roles que otra
-- marca de esa organización (p. ej. la cuenta de la agencia como editora).
-- Sin código de ningún cliente: los datos van en los parámetros.
--
-- Uso: rellena los parámetros de abajo, revísalo y ejecútalo entero en el
-- editor SQL del proyecto que toque (rol `postgres`). Es una transacción: o
-- se hace todo o nada. Si ya hay una marca (no archivada) con ese nombre en la
-- organización, no crea otra: la pone en modo agencia, completa sus miembros y
-- la muestra. Al final sale el `brand_id`, que es lo que va en el mapeo de
-- scripts/alta-biblioteca.ts. Los límites de marcas del plan de la
-- organización se aplican igual que desde la aplicación.
--
-- Mientras los parámetros sigan con «<…>» falla al convertirlos a uuid y no
-- hace nada.

begin;

create temp table _marca_nueva on commit drop as
select
  '<organization_id>'::uuid as organization_id,          -- organización donde se crea
  '<nombre de la marca>'::text as name,
  ''::text as sector,                                     -- p. ej. «Coctelería»
  ''::text as website,                                    -- p. ej. «https://…»
  'Europe/Madrid'::text as timezone,
  'es'::text as default_locale,
  nullif('<brand_id de referencia o vacío>', '')::uuid as members_from; -- copia sus miembros y roles

do $$
declare
  p record;
  v_brand uuid;
begin
  select * into strict p from _marca_nueva;
  if not exists (select 1 from public.organizations o where o.id = p.organization_id) then
    raise exception 'No existe la organización %', p.organization_id;
  end if;
  if btrim(coalesce(p.name, '')) = '' then
    raise exception 'Falta el nombre de la marca';
  end if;
  if p.members_from is not null and not exists (
    select 1 from public.brands b where b.id = p.members_from and b.organization_id = p.organization_id
  ) then
    raise exception 'La marca de referencia % no es de la organización %', p.members_from, p.organization_id;
  end if;

  select b.id into v_brand
  from public.brands b
  where b.organization_id = p.organization_id
    and lower(btrim(b.name)) = lower(btrim(p.name))
    and b.status <> 'archived'
  order by b.created_at
  limit 1;

  if v_brand is null then
    insert into public.brands (organization_id, name, sector, website, timezone, default_locale, ai_mode, created_by)
    values (p.organization_id, btrim(p.name), p.sector, p.website, p.timezone, p.default_locale, 'agency', null)
    returning id into v_brand;
    raise notice 'Marca creada: %', v_brand;
  else
    update public.brands set ai_mode = 'agency' where id = v_brand and ai_mode <> 'agency';
    raise notice 'La marca ya existía: % (queda en modo agencia)', v_brand;
  end if;

  if p.members_from is not null then
    insert into public.brand_members (brand_id, organization_id, user_id, role)
    select v_brand, p.organization_id, m.user_id, m.role
    from public.brand_members m
    where m.brand_id = p.members_from
    on conflict (brand_id, user_id) do nothing;
  end if;
end $$;

select b.id as brand_id, b.organization_id, b.name, b.ai_mode, b.status,
       (select count(*) from public.brand_members m where m.brand_id = b.id) as members
from public.brands b
join _marca_nueva p on p.organization_id = b.organization_id and lower(btrim(b.name)) = lower(btrim(p.name))
where b.status <> 'archived';

commit;
