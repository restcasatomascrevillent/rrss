-- Vuelta atrás de 20261119620000_analytics_reports.sql.
-- BORRA el registro de informes. Los PDF ya generados se quedan en la
-- biblioteca (media_assets y almacenamiento) con su procedencia. Los trabajos
-- `analytics.report` y `media.report.pdf` que hubiera en la cola quedan sin atender.
drop trigger if exists jobs_fail_analytics_report on public.jobs;
drop trigger if exists jobs_publish_analytics_report on public.jobs;
drop trigger if exists media_assets_guard_report_provenance on public.media_assets;

drop function if exists public.analytics_report_render(uuid, uuid, jsonb, jsonb);
drop function if exists public.analytics_report_source(uuid);
drop function if exists public.analytics_enqueue_monthly_reports(date);
drop function if exists public.request_analytics_report(uuid, date);
drop function if exists private.jobs_fail_analytics_report();
drop function if exists private.jobs_publish_analytics_report();
drop function if exists private.analytics_report_enqueue(uuid, date, text, uuid);
drop function if exists private.media_assets_guard_report_provenance();

drop table if exists public.analytics_reports;
