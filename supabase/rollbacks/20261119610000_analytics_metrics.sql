-- Vuelta atrás de 20261119610000_analytics_metrics.sql.
-- BORRA las cifras capturadas (series de cuentas y de publicaciones), el
-- registro de capturas y el catálogo de métricas. Los trabajos
-- `analytics.capture` que hubiera en la cola quedan sin atender.
drop function if exists public.analytics_media_summary(uuid, timestamptz, timestamptz);
drop function if exists public.analytics_defer_job(uuid, text, integer, text);
drop function if exists public.analytics_record_capture(uuid, uuid, text, timestamptz, date, date, jsonb, jsonb, jsonb,
                                                         integer, text, text);
drop function if exists public.analytics_capture_begin(uuid);
drop function if exists public.analytics_enqueue_captures(date);
drop function if exists private.analytics_is_provisional(text, integer, date, timestamptz, timestamptz);

drop table if exists public.analytics_capture_runs;
drop table if exists public.media_metrics_daily;
drop table if exists public.account_metrics_daily;
drop table if exists public.analytics_metric_definitions;
