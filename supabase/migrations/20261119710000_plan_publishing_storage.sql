-- Fases 3–6 juntas: los límites del plan (20261119310000) alcanzan a lo que
-- trajeron las otras ramas.
--
-- 1. Publicación (función del plan «publishing», PL002):
--    * empezar a conectar una cuenta (`social_oauth_begin` guarda el estado
--      anti-CSRF en `private.social_oauth_states`) y darla de alta
--      (`social_account_connect`, al volver de Meta);
--    * programar una pieza EN una cuenta (`save_publication` con cuenta, al
--      crearla o al cambiar de cuenta). Planificar en el calendario sin cuenta
--      sigue permitido: no publica nada.
--    Se hace con disparadores para que valga por cualquier camino.
--    Pendiente a propósito: si una organización baja a un plan sin publicación,
--    lo que ya estaba armado en una cuenta no se detiene solo.
-- 2. Almacenamiento (PL001):
--    * las tipografías de marca (`brand_fonts`) cuentan en el espacio usado y
--      no se suben si no caben;
--    * sin espacio no se encarga la extracción de texto de una fuente
--      (`source.extract`), igual que los reels y los recortes.

-- ─────────────────────────── 1. Publicación ───────────────────────────

create function private.require_publishing_plan() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'scheduled_publications' then
    if new.social_account_id is null
       or (tg_op = 'UPDATE' and new.social_account_id is not distinct from old.social_account_id) then
      return new;
    end if;
  end if;
  perform private.require_plan_feature(new.organization_id, 'publishing');
  return new;
end $$;

create trigger social_oauth_states_plan_feature before insert on private.social_oauth_states
  for each row execute function private.require_publishing_plan();
create trigger social_accounts_plan_feature before insert on public.social_accounts
  for each row execute function private.require_publishing_plan();
create trigger scheduled_publications_plan_feature
  before insert or update of social_account_id on public.scheduled_publications
  for each row execute function private.require_publishing_plan();

-- ─────────────────────────── 2. Almacenamiento ───────────────────────────

create or replace function private.org_storage_bytes(p_organization_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(ma.bytes) from public.media_assets ma where ma.organization_id = p_organization_id), 0)
        + coalesce((select sum(ks.bytes) from public.brand_knowledge_sources ks
                    where ks.organization_id = p_organization_id), 0)
        + coalesce((select sum(bf.bytes) from public.brand_fonts bf where bf.organization_id = p_organization_id), 0)
         )::bigint;
$$;

create trigger brand_fonts_plan_limit before insert on public.brand_fonts
  for each row execute function private.storage_plan_limit();

create or replace function private.jobs_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'media.reel.template' then
    perform private.require_plan_feature(new.organization_id, 'reels');
  end if;
  if new.kind in ('media.reel.template', 'media.image.process', 'source.extract') then
    perform private.check_storage_limit(new.organization_id, 0);
  end if;
  return new;
end $$;

-- ───────────────────────────── Privilegios ─────────────────────────────

revoke all on function private.require_publishing_plan() from public, anon;
grant execute on function private.require_publishing_plan() to authenticated, service_role;
