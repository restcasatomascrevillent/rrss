-- Vuelta atrás de 20261119010000_social_accounts.sql.
-- DESTRUCTIVA: borra las cuentas conectadas y sus tokens cifrados (habría que
-- volver a conectarlas) y los estados de OAuth a medias.
drop function if exists public.social_account_report(uuid, text, text, timestamptz, integer, integer, boolean);
drop function if exists public.social_account_token(uuid);
drop function if exists public.social_account_connect(uuid, uuid, text, text, text, text, text, text[], timestamptz, text,
                                                      text, text);
drop function if exists public.social_oauth_consume(text);
drop function if exists public.disconnect_social_account(uuid);
drop function if exists public.social_oauth_begin(uuid, text);

drop table if exists private.social_oauth_states;
drop table if exists private.social_account_secrets;
drop table if exists public.social_accounts cascade;
