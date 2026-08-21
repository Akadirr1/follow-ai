-- 202608210011_ai_provider_keys.sql
-- Widen the Vault allow-list so the enrichment worker can read its model
-- provider keys (addendum §H).
--
-- WHY: there is no Anthropic key and there will not be one. The human has a
-- Google AI Studio key and an NVIDIA NIM key, already stored in Vault by the
-- coordinator as `aigundem_gemini_api_key` and `aigundem_nvidia_api_key`. No
-- Edge Function environment secret can be set for this project, so Vault is the
-- only place a key can live — the same constraint that put the automations
-- secret there in 0008.
--
-- Applied migrations are immutable, so this is a `create or replace` of
-- `aigundem.internal_get_setting` with a three-name allow-list. Everything else
-- about the function is byte-identical to 0008: same signature, same
-- SECURITY DEFINER, same `search_path = ''`, same Vault read, same error code.
--
-- THE ALLOW-LIST IS THE SECURITY BOUNDARY, not the grant. Without it this is a
-- read-any-secret primitive, and one future mistake about who may EXECUTE it
-- would expose every secret the project holds rather than these three. Adding a
-- name here is a deliberate act; the list is short so it stays reviewable.

create or replace function aigundem.internal_get_setting(p_name text)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_value text;
begin
  if p_name is null
     or p_name not in (
          'aigundem_automations_secret',
          'aigundem_gemini_api_key',
          'aigundem_nvidia_api_key'
        ) then
    raise exception 'get_setting: name is not on the allow-list'
      using errcode = '22023';
  end if;

  select v.decrypted_secret
    into v_value
    from vault.decrypted_secrets v
   where v.name = p_name;

  return v_value;
end;
$fn$;

comment on function aigundem.internal_get_setting(text) is
  'Reads one allow-listed Vault secret by name: the automations secret and the Gemini/NVIDIA API keys. service_role only.';

-- Privileges survive CREATE OR REPLACE; re-asserted so an audit can read the
-- current state from this file alone, exactly as 0009 and 0010 do.
revoke all on function aigundem.internal_get_setting(text) from public, anon, authenticated;
grant execute on function aigundem.internal_get_setting(text) to service_role;

notify pgrst, 'reload schema';
