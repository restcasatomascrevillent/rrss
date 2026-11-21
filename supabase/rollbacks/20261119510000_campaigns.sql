-- Vuelta atrás de 20261119510000_campaigns.sql.
-- DESTRUCTIVA: elimina todas las campañas, sus planes y los encargos de tipo
-- «plan» (con su conversación). En un entorno con datos hay que exportar antes
-- `campaigns`, `campaign_plans`, `campaign_contents` y los `content_requests`
-- con kind = 'plan'. Las piezas creadas como borradores se quedan.
drop function if exists public.discard_campaign(uuid, text);
drop function if exists public.accept_campaign_plan(uuid, integer, jsonb, jsonb);
drop function if exists public.deliver_campaign_plan(uuid, jsonb, text, text);
drop function if exists public.request_campaign_plan(uuid, text, text, text[], date, date);
drop function if exists public.create_campaign(uuid, text, text, text[], date, date, jsonb, uuid);

drop trigger if exists content_requests_plan_cancelled on public.content_requests;
drop trigger if exists content_requests_plan_guard on public.content_requests;
drop function if exists private.content_requests_plan_cancelled();
drop function if exists private.content_requests_plan_guard();

drop function if exists private.campaign_lock_for_decision(uuid);
drop function if exists private.campaign_add_plan(public.campaigns, jsonb, text, uuid);
drop function if exists private.campaign_check_input(text, text, text[], date, date);
drop function if exists private.campaign_plan_problem(jsonb, public.campaigns);
drop function if exists private.jsonb_text_ok(jsonb, integer, integer);
drop function if exists private.jsonb_text_list_ok(jsonb, integer, integer);

-- Encargos: fuera los de tipo «plan» y lo añadido; vuelve la regla original.
delete from public.content_requests where kind = 'plan';
drop index if exists public.content_requests_campaign_idx;
alter table public.content_requests
  drop constraint if exists content_requests_delivered_piece_check,
  drop constraint if exists content_requests_delivered_plan_check,
  drop constraint if exists content_requests_plan_no_piece_check,
  drop constraint if exists content_requests_plan_campaign_check,
  drop constraint if exists content_requests_campaign_fk,
  drop column if exists delivered_plan_version,
  drop column if exists campaign_id,
  drop column if exists kind;
alter table public.content_requests
  add constraint content_requests_check
    check (status not in ('delivered', 'accepted') or (content_id is not null and delivered_version is not null));

drop table if exists public.campaign_contents, public.campaign_plans, public.campaigns cascade;

drop type if exists public.campaign_status;
