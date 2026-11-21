-- Vuelta atrás de 20261126010000_integrations_openai.sql. Borra los ajustes de
-- OpenAI guardados en Plataforma → Integraciones (con su secreto de Vault) y
-- los quita del catálogo. Si alguna tarea tenía elegido «openai» como
-- proveedor, esa tarea dejará de generar hasta que se elija otro.

do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets vs
    where vs.id in (
      select s.vault_secret_id from private.integration_settings s
      where s.vault_secret_id is not null
        and s.setting_key in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT')
    );
  end if;
end $$;

-- Los valores caen en cascada con su ajuste del catálogo.
delete from private.integration_setting_keys
where setting_key in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT');
