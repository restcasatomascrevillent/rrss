-- Vuelta atrás de 20261119410000_rgpd_derechos.sql.
-- DESTRUCTIVA: elimina las aceptaciones de las condiciones y de la política de
-- privacidad (la prueba de que se aceptaron). En un entorno con datos hay que
-- exportar antes `legal_acceptances`. Lo ya borrado o anonimizado no vuelve.
drop trigger if exists zz_on_auth_user_deleted on auth.users;
drop trigger if exists on_auth_user_deleting on auth.users;
drop trigger if exists on_auth_user_created_legal on auth.users;

drop function if exists public.gdpr_forget_storage_paths(text[]);
drop function if exists public.gdpr_delete_account_data(uuid);
drop function if exists public.gdpr_delete_organization(uuid, uuid, text);
drop function if exists public.my_account_deletion_check();
drop function if exists public.export_organization_data(uuid);
drop function if exists public.export_my_data();
drop function if exists public.accept_legal_documents(text, text);

drop function if exists private.forget_user_after_delete();
drop function if exists private.forget_user_before_delete();
drop function if exists private.scrub_user_from_audit(uuid, text);
drop function if exists private.scrub_user_from_json(jsonb, uuid, text);
drop function if exists private.delete_organization_data(uuid, uuid);
drop function if exists private.organization_storage_paths(uuid);
drop function if exists private.account_deletion_plan(uuid);
drop function if exists private.record_signup_legal_acceptance();
drop function if exists private.legal_version_valid(text);

drop table if exists public.legal_acceptances;
