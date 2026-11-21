-- Vuelta atrás de 20261119710000_plan_publishing_storage.sql. No borra datos:
-- quita las comprobaciones y deja las funciones como en 20261119310000.

drop trigger if exists scheduled_publications_plan_feature on public.scheduled_publications;
drop trigger if exists social_accounts_plan_feature on public.social_accounts;
drop trigger if exists social_oauth_states_plan_feature on private.social_oauth_states;
drop function if exists private.require_publishing_plan();

drop trigger if exists brand_fonts_plan_limit on public.brand_fonts;

create or replace function private.org_storage_bytes(p_organization_id uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(ma.bytes) from public.media_assets ma where ma.organization_id = p_organization_id), 0)
        + coalesce((select sum(ks.bytes) from public.brand_knowledge_sources ks
                    where ks.organization_id = p_organization_id), 0))::bigint;
$$;

create or replace function private.jobs_plan_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.kind = 'media.reel.template' then
    perform private.require_plan_feature(new.organization_id, 'reels');
  end if;
  if new.kind in ('media.reel.template', 'media.image.process') then
    perform private.check_storage_limit(new.organization_id, 0);
  end if;
  return new;
end $$;
