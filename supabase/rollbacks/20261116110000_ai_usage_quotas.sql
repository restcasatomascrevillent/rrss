-- Vuelta atrás de 20261116110000_ai_usage_quotas.sql.
-- DESTRUCTIVA: elimina el registro de generaciones, el libro de consumo y los
-- cupos. El libro de consumo es la única fuente del coste de IA por cliente:
-- en un entorno con datos hay que exportar `ai_usage` antes de aplicarla.
drop function if exists public.ai_cost_by_organization(timestamptz, timestamptz);
drop function if exists public.admin_set_ai_quota(uuid, bigint);
drop function if exists public.ai_fail_generation(uuid, text, text, integer);
drop function if exists public.ai_complete_generation(uuid, bigint, jsonb, jsonb, integer, text);
drop function if exists public.ai_reserve_generation(uuid, uuid, public.ai_task, text, text, text, bigint, integer);

drop table if exists public.ai_usage, public.ai_generations, public.usage_quotas cascade;

drop function if exists private.ai_release_expired(uuid);
drop function if exists private.user_has_brand_capability(uuid, uuid, text);
drop function if exists private.ai_period_start(timestamptz);

drop type if exists public.ai_generation_status, public.ai_task;
