-- Own-relay OAuth pairing (v2). Applies after 20260924204925_control_plane_v1.sql.
--
-- The plane never holds user/device tokens. It only relays a Supabase OAuth
-- authorization code from /device/callback to the device that proved PKCE on
-- /device/poll; the device exchanges that code itself at /auth/v1/oauth/token.
-- The code is stored only as AES-256-GCM ciphertext (key held by the plane,
-- AAD = session_id), lives at most p_code_ttl_seconds, and is wiped on every
-- terminal transition.

-- Removes the v1 browser-token handoff (the plane held the browser's access
-- token between /device/verify and /device/poll).
drop function if exists public.verify_mcp_pairing_session_server(text, text, uuid);
drop function if exists public.consume_mcp_pairing_session_server(text, text);

alter table public.mcp_pairing_sessions
  add column if not exists state_nonce_hash text check (state_nonce_hash is null or octet_length(state_nonce_hash) = 43),
  add column if not exists code_ciphertext text check (code_ciphertext is null or octet_length(code_ciphertext) <= 4096),
  add column if not exists code_expires_at timestamptz;

alter table public.mcp_pairing_sessions drop constraint if exists mcp_pairing_sessions_code_only_when_verified;
alter table public.mcp_pairing_sessions add constraint mcp_pairing_sessions_code_only_when_verified check (
  (code_ciphertext is null and code_expires_at is null)
  or (state = 'VERIFIED' and code_ciphertext is not null and code_expires_at is not null)
);
alter table public.mcp_pairing_sessions drop constraint if exists mcp_pairing_sessions_nonce_only_when_pending;
alter table public.mcp_pairing_sessions add constraint mcp_pairing_sessions_nonce_only_when_pending check (
  state_nonce_hash is null or state = 'PENDING'
);

-- Binds the latest /add-device visit's state nonce (hash only) to a live PENDING session.
create or replace function public.set_mcp_pairing_nonce_server(p_session_id text, p_nonce_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_nonce_hash is null or octet_length(p_nonce_hash) <> 43 then return false; end if;
  update public.mcp_pairing_sessions set state_nonce_hash = p_nonce_hash
    where session_id = p_session_id and state = 'PENDING' and expires_at > clock_timestamp();
  return found;
end $$;
revoke all on function public.set_mcp_pairing_nonce_server(text, text) from public, anon, authenticated;
grant execute on function public.set_mcp_pairing_nonce_server(text, text) to service_role;

-- /device/callback success. A second callback for a VERIFIED session is a replay:
-- the session is REJECTED and the sealed code wiped so neither party can use it.
create or replace function public.store_mcp_pairing_code_server(
  p_session_id text, p_nonce_hash text, p_code_ciphertext text, p_code_ttl_seconds integer
) returns text language plpgsql security definer set search_path = '' as $$
declare v public.mcp_pairing_sessions; v_now timestamptz := clock_timestamp();
begin
  if p_code_ttl_seconds is null or p_code_ttl_seconds < 1 or p_code_ttl_seconds > 600 then raise exception 'invalid code ttl'; end if;
  if p_code_ciphertext is null or octet_length(p_code_ciphertext) = 0 then raise exception 'invalid code'; end if;
  select * into v from public.mcp_pairing_sessions where session_id = p_session_id for update;
  if v.session_id is null then return 'unknown'; end if;
  if v.state = 'VERIFIED' then
    update public.mcp_pairing_sessions set state = 'REJECTED', code_ciphertext = null, code_expires_at = null, state_nonce_hash = null
      where session_id = p_session_id;
    return 'rejected';
  end if;
  if v.state <> 'PENDING' then return 'invalid'; end if;
  if v.expires_at <= v_now then
    update public.mcp_pairing_sessions set state = 'EXPIRED', state_nonce_hash = null where session_id = p_session_id;
    return 'expired';
  end if;
  if v.state_nonce_hash is null or v.state_nonce_hash <> p_nonce_hash then return 'invalid'; end if;
  update public.mcp_pairing_sessions
    set state = 'VERIFIED', verified_at = v_now, state_nonce_hash = null,
        code_ciphertext = p_code_ciphertext, code_expires_at = v_now + make_interval(secs => p_code_ttl_seconds)
    where session_id = p_session_id;
  return 'verified';
end $$;
revoke all on function public.store_mcp_pairing_code_server(text, text, text, integer) from public, anon, authenticated;
grant execute on function public.store_mcp_pairing_code_server(text, text, text, integer) to service_role;

-- /device/callback with an OAuth error (user denied), or a replay against a VERIFIED session.
create or replace function public.reject_mcp_pairing_session_server(p_session_id text, p_nonce_hash text)
returns text language plpgsql security definer set search_path = '' as $$
begin
  update public.mcp_pairing_sessions
    set state = 'REJECTED', code_ciphertext = null, code_expires_at = null, state_nonce_hash = null
    where session_id = p_session_id
      and (state = 'VERIFIED' or (state = 'PENDING' and state_nonce_hash is not null and state_nonce_hash = p_nonce_hash));
  if found then return 'rejected'; end if;
  if exists (select 1 from public.mcp_pairing_sessions where session_id = p_session_id) then return 'invalid'; end if;
  return 'unknown';
end $$;
revoke all on function public.reject_mcp_pairing_session_server(text, text) from public, anon, authenticated;
grant execute on function public.reject_mcp_pairing_session_server(text, text) to service_role;

-- /device/poll, called only after the plane verified PKCE (S256) against code_challenge.
-- A single UPDATE both consumes the session and wipes the sealed code, returning
-- the pre-update ciphertext exactly once. A second poll sees CONSUMED.
create or replace function public.consume_mcp_pairing_code_server(p_session_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := clock_timestamp(); v_code text; v_device uuid; v_state text; v_expires timestamptz;
begin
  update public.mcp_pairing_sessions s
    set state = 'CONSUMED', consumed_at = v_now, code_ciphertext = null, code_expires_at = null
    from (
      select p.session_id, p.code_ciphertext from public.mcp_pairing_sessions p
      where p.session_id = p_session_id and p.state = 'VERIFIED' and p.code_expires_at > v_now
      for update
    ) prior
    where s.session_id = prior.session_id
    returning prior.code_ciphertext, s.device_id into v_code, v_device;
  if v_code is not null then
    return jsonb_build_object('outcome', 'code', 'code_ciphertext', v_code, 'device_id', v_device);
  end if;

  select p.state, p.expires_at into v_state, v_expires from public.mcp_pairing_sessions p where p.session_id = p_session_id for update;
  if v_state is null then return jsonb_build_object('outcome', 'unknown'); end if;
  if v_state = 'VERIFIED' or (v_state = 'PENDING' and v_expires <= v_now) then
    update public.mcp_pairing_sessions
      set state = 'EXPIRED', code_ciphertext = null, code_expires_at = null, state_nonce_hash = null
      where session_id = p_session_id;
    return jsonb_build_object('outcome', 'expired');
  end if;
  return jsonb_build_object('outcome', case v_state
    when 'PENDING' then 'pending'
    when 'REJECTED' then 'rejected'
    when 'CONSUMED' then 'consumed'
    else 'expired' end);
end $$;
revoke all on function public.consume_mcp_pairing_code_server(text) from public, anon, authenticated;
grant execute on function public.consume_mcp_pairing_code_server(text) to service_role;
