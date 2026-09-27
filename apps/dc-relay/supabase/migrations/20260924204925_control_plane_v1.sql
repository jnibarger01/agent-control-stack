-- Jace-owned Desktop Commander control plane v1.
-- Invariant: Presence is live transport truth; Postgres is durable metadata;
-- authorization is session-bound; local MCP readiness is separate.
create extension if not exists pgcrypto;
create schema if not exists control_plane_private;
revoke all on schema control_plane_private from public;
grant usage on schema control_plane_private to authenticated, service_role;

create table if not exists public.mcp_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_name text not null check (octet_length(device_name) between 1 and 128),
  capabilities jsonb not null default '{}'::jsonb check (octet_length(capabilities::text) <= 8192),
  -- Compatibility/diagnostic only. No authorization function or RLS policy may
  -- use this column as evidence of live connectivity.
  status text not null default 'offline' check (status in ('online', 'offline')),
  last_seen timestamptz not null default now(),
  last_error text check (last_error is null or octet_length(last_error) <= 4096),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 8192),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mcp_devices_user_active_idx on public.mcp_devices(user_id) where revoked_at is null;

-- Short-lived server-owned device pairing state. session_id is the canonical
-- pairing identity; device_code exists only for legacy connector compatibility.
create table if not exists public.mcp_pairing_sessions (
  session_id text primary key check (octet_length(session_id) between 43 and 512),
  device_code text not null unique check (octet_length(device_code) between 43 and 512),
  user_code text not null unique check (user_code ~ '^[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  device_id uuid references public.mcp_devices(id) on delete set null,
  device_name text not null check (octet_length(device_name) between 1 and 128),
  code_challenge text not null check (octet_length(code_challenge) between 43 and 128),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  state text not null default 'PENDING' check (state in ('PENDING', 'VERIFIED', 'CONSUMED', 'EXPIRED', 'REJECTED')),
  user_id uuid references auth.users(id) on delete cascade,
  verified_at timestamptz,
  consumed_at timestamptz,
  constraint mcp_pairing_sessions_state_user_consistency check ((state = 'PENDING' and user_id is null and verified_at is null) or state <> 'PENDING')
);
create index if not exists mcp_pairing_sessions_expiry_idx on public.mcp_pairing_sessions(expires_at) where state = 'PENDING';

-- One currently-authorized Supabase Auth session owns one device binding.
-- auth_session_id is an identifier, never a bearer credential.
create table if not exists public.mcp_device_sessions (
  device_id uuid primary key references public.mcp_devices(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  auth_session_id uuid not null,
  generation bigint not null default 1 check (generation > 0),
  bound_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index if not exists mcp_device_sessions_one_device_per_live_auth_session
  on public.mcp_device_sessions(user_id, auth_session_id) where revoked_at is null;

create table if not exists public.mcp_remote_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.mcp_devices(id) on delete restrict,
  target_auth_session_id uuid not null,
  target_connection_generation uuid not null,
  tool_name text not null check (octet_length(tool_name) between 1 and 128),
  tool_args jsonb not null default '{}'::jsonb check (octet_length(tool_args::text) <= 65536),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 8192),
  idempotency_key text not null check (octet_length(idempotency_key) between 1 and 128),
  status text not null default 'pending' check (status in ('pending', 'executing', 'completed', 'failed', 'timed_out', 'cancelled')),
  claimed_session_id uuid,
  claimed_connection_generation uuid,
  claimed_at timestamptz,
  deadline_at timestamptz not null,
  completed_at timestamptz,
  result jsonb check (result is null or octet_length(result::text) <= 262144),
  error_message text check (error_message is null or octet_length(error_message) <= 4096),
  created_at timestamptz not null default now(),
  constraint mcp_remote_calls_idempotency_unique unique (user_id, device_id, idempotency_key)
);
create index if not exists mcp_remote_calls_device_pending_idx on public.mcp_remote_calls(device_id, status, created_at);
create index if not exists mcp_remote_calls_deadline_idx on public.mcp_remote_calls(deadline_at) where status in ('pending', 'executing');

alter table public.mcp_devices enable row level security;
alter table public.mcp_device_sessions enable row level security;
alter table public.mcp_remote_calls enable row level security;
alter table public.mcp_pairing_sessions enable row level security;

revoke all on public.mcp_devices, public.mcp_device_sessions, public.mcp_remote_calls, public.mcp_pairing_sessions from anon, authenticated;
grant select on public.mcp_devices, public.mcp_remote_calls to authenticated;
-- The legacy connector may update only diagnostics and non-authoritative metadata.
grant update (device_name, capabilities, status, last_seen, last_error, metadata, updated_at) on public.mcp_devices to authenticated;

-- Pairing sessions are never directly readable or writable by browser/device
-- clients. The server-only functions below are the atomic state boundary.
revoke all on public.mcp_pairing_sessions from public, anon, authenticated;

create or replace function public.verify_mcp_pairing_session_server(
  p_session_id text, p_user_code text, p_user_id uuid
) returns public.mcp_pairing_sessions
language plpgsql security definer set search_path = '' as $$
declare v public.mcp_pairing_sessions;
begin
  select * into v from public.mcp_pairing_sessions where session_id = p_session_id for update;
  if v.session_id is null then return null; end if;
  if v.state = 'PENDING' and v.expires_at <= clock_timestamp() then
    update public.mcp_pairing_sessions set state = 'EXPIRED' where session_id = p_session_id returning * into v;
    return v;
  end if;
  if v.state = 'CONSUMED' or v.state = 'REJECTED' then return v; end if;
  if v.user_code <> p_user_code then return null; end if;
  if v.state = 'VERIFIED' then return v; end if;
  if p_user_id is null then return null; end if;
  update public.mcp_pairing_sessions
    set state = 'VERIFIED', user_id = p_user_id, verified_at = clock_timestamp()
    where session_id = p_session_id and state = 'PENDING'
    returning * into v;
  return v;
end $$;
revoke all on function public.verify_mcp_pairing_session_server(text, text, uuid) from public, anon, authenticated;
grant execute on function public.verify_mcp_pairing_session_server(text, text, uuid) to service_role;

create or replace function public.consume_mcp_pairing_session_server(
  p_session_id text, p_device_code text
) returns public.mcp_pairing_sessions
language plpgsql security definer set search_path = '' as $$
declare v public.mcp_pairing_sessions;
begin
  update public.mcp_pairing_sessions set state = 'CONSUMED', consumed_at = clock_timestamp()
    where session_id = p_session_id and device_code = p_device_code and state = 'VERIFIED'
    returning * into v;
  return v;
end $$;
revoke all on function public.consume_mcp_pairing_session_server(text, text) from public, anon, authenticated;
grant execute on function public.consume_mcp_pairing_session_server(text, text) to service_role;

-- Safe JWT session-id extraction. Invalid/missing values fail closed to NULL.
create or replace function control_plane_private.current_session_id()
returns uuid language plpgsql stable security invoker set search_path = '' as $$
declare v text;
begin
  v := auth.jwt() ->> 'session_id';
  if v is null or v !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return null; end if;
  return v::uuid;
end $$;
revoke all on function control_plane_private.current_session_id() from public;
grant execute on function control_plane_private.current_session_id() to authenticated, service_role;

-- Strong session validity for consequential operations: the JWT session_id must
-- still exist in auth.sessions, not merely have an unexpired access-token signature.
create or replace function control_plane_private.auth_session_is_active(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id is not null and p_session_id is not null and exists (
    select 1 from auth.sessions s where s.id = p_session_id and s.user_id = p_user_id
  );
$$;
revoke all on function control_plane_private.auth_session_is_active(uuid, uuid) from public;
grant execute on function control_plane_private.auth_session_is_active(uuid, uuid) to authenticated, service_role;

create or replace function control_plane_private.device_session_is_active(p_device_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.mcp_devices d
    join public.mcp_device_sessions ds on ds.device_id = d.id and ds.user_id = d.user_id
    join auth.sessions s on s.id = ds.auth_session_id and s.user_id = ds.user_id
    where d.id = p_device_id
      and d.user_id = auth.uid()
      and d.revoked_at is null
      and ds.revoked_at is null
      and ds.auth_session_id = control_plane_private.current_session_id()
  );
$$;
revoke all on function control_plane_private.device_session_is_active(uuid) from public;
grant execute on function control_plane_private.device_session_is_active(uuid) to authenticated, service_role;

create or replace function control_plane_private.topic_user_id(p_topic text)
returns uuid language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_topic !~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:device:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return null; end if;
  return split_part(p_topic, ':', 2)::uuid;
end $$;
create or replace function control_plane_private.topic_device_id(p_topic text)
returns uuid language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_topic !~ '^user:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:device:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return null; end if;
  return split_part(p_topic, ':', 4)::uuid;
end $$;
revoke all on function control_plane_private.topic_user_id(text), control_plane_private.topic_device_id(text) from public;
grant execute on function control_plane_private.topic_user_id(text), control_plane_private.topic_device_id(text) to authenticated, service_role;

create or replace function control_plane_private.owns_active_device(p_device_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mcp_devices d
    where d.id = p_device_id and d.user_id = auth.uid() and d.revoked_at is null
  ) and control_plane_private.auth_session_is_active(auth.uid(), control_plane_private.current_session_id());
$$;
revoke all on function control_plane_private.owns_active_device(uuid) from public;
grant execute on function control_plane_private.owns_active_device(uuid) to authenticated, service_role;

create policy mcp_devices_select_own on public.mcp_devices
  for select to authenticated using ((select auth.uid()) = user_id);
create policy mcp_devices_bound_session_update on public.mcp_devices
  for update to authenticated
  using ((select auth.uid()) = user_id and revoked_at is null and control_plane_private.device_session_is_active(id))
  with check ((select auth.uid()) = user_id and revoked_at is null and control_plane_private.device_session_is_active(id));
create policy mcp_remote_calls_select_own on public.mcp_remote_calls
  for select to authenticated using ((select auth.uid()) = user_id);
-- No authenticated policy/grant exists for mcp_device_sessions or direct call mutation.

-- Server-only registration/session binding. The Vercel control plane calls this
-- after a reviewed device authorization flow. It is not callable by devices.
create or replace function public.bind_mcp_device_session_server(
  p_user_id uuid, p_device_id uuid, p_auth_session_id uuid
) returns public.mcp_device_sessions
language plpgsql security definer set search_path = '' as $$
declare v public.mcp_device_sessions; v_generation bigint;
begin
  if not control_plane_private.auth_session_is_active(p_user_id, p_auth_session_id) then raise exception 'invalid auth session'; end if;
  if not exists (select 1 from public.mcp_devices d where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null) then raise exception 'device unavailable'; end if;
  if exists (select 1 from public.mcp_device_sessions ds where ds.user_id = p_user_id and ds.auth_session_id = p_auth_session_id and ds.device_id <> p_device_id and ds.revoked_at is null) then raise exception 'auth session already bound'; end if;
  select coalesce(ds.generation, 0) + 1 into v_generation from public.mcp_device_sessions ds where ds.device_id = p_device_id;
  v_generation := coalesce(v_generation, 1);
  insert into public.mcp_device_sessions(device_id, user_id, auth_session_id, generation, bound_at, last_seen, revoked_at)
  values (p_device_id, p_user_id, p_auth_session_id, v_generation, clock_timestamp(), clock_timestamp(), null)
  on conflict (device_id) do update set user_id = excluded.user_id, auth_session_id = excluded.auth_session_id,
    generation = excluded.generation, bound_at = excluded.bound_at, last_seen = excluded.last_seen, revoked_at = null
  returning * into v;
  return v;
end $$;
revoke all on function public.bind_mcp_device_session_server(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.bind_mcp_device_session_server(uuid, uuid, uuid) to service_role;


create or replace function public.get_mcp_device_session_server(p_user_id uuid, p_device_id uuid)
returns public.mcp_device_sessions language plpgsql security definer set search_path = '' as $$
declare v public.mcp_device_sessions;
begin
  select ds.* into v
  from public.mcp_device_sessions ds
  join public.mcp_devices d on d.id = ds.device_id and d.user_id = ds.user_id
  join auth.sessions s on s.id = ds.auth_session_id and s.user_id = ds.user_id
  where ds.user_id = p_user_id and ds.device_id = p_device_id
    and ds.revoked_at is null and d.revoked_at is null;
  return v;
end $$;
revoke all on function public.get_mcp_device_session_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_mcp_device_session_server(uuid, uuid) to service_role;


create or replace function public.control_plane_auth_session_active_server(p_user_id uuid, p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select control_plane_private.auth_session_is_active(p_user_id, p_session_id);
$$;
revoke all on function public.control_plane_auth_session_active_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.control_plane_auth_session_active_server(uuid, uuid) to service_role;

create or replace function public.revoke_mcp_device_server(p_user_id uuid, p_device_id uuid)
returns public.mcp_devices language plpgsql security definer set search_path = '' as $$
declare v public.mcp_devices; v_now timestamptz := clock_timestamp();
begin
  update public.mcp_devices set revoked_at = v_now, status = 'offline', updated_at = v_now
    where id = p_device_id and user_id = p_user_id and revoked_at is null returning * into v;
  if v.id is null then return null; end if;
  update public.mcp_device_sessions set revoked_at = v_now where device_id = p_device_id and user_id = p_user_id and revoked_at is null;
  return v;
end $$;
revoke all on function public.revoke_mcp_device_server(uuid, uuid) from public, anon, authenticated;
grant execute on function public.revoke_mcp_device_server(uuid, uuid) to service_role;

-- Server-only durable creation. Live Presence is checked by the Vercel service
-- immediately before this RPC; this function revalidates durable authorization
-- and freezes the observed session + Presence connection generation into the call.
create or replace function public.create_mcp_remote_call_server(
  p_user_id uuid, p_device_id uuid, p_target_auth_session_id uuid, p_target_connection_generation uuid,
  p_tool_name text, p_tool_args jsonb, p_metadata jsonb, p_idempotency_key text, p_deadline_at timestamptz
) returns public.mcp_remote_calls
language plpgsql security definer set search_path = '' as $$
declare v public.mcp_remote_calls; v_inserted boolean := false;
begin
  if p_target_connection_generation is null or p_deadline_at <= clock_timestamp() then raise exception 'invalid dispatch'; end if;
  if not exists (
    select 1 from public.mcp_devices d
    join public.mcp_device_sessions ds on ds.device_id = d.id and ds.user_id = d.user_id
    join auth.sessions s on s.id = ds.auth_session_id and s.user_id = ds.user_id
    where d.id = p_device_id and d.user_id = p_user_id and d.revoked_at is null
      and ds.revoked_at is null and ds.auth_session_id = p_target_auth_session_id
  ) then raise exception 'device unavailable'; end if;
  insert into public.mcp_remote_calls(
    user_id, device_id, target_auth_session_id, target_connection_generation,
    tool_name, tool_args, metadata, idempotency_key, deadline_at
  ) values (
    p_user_id, p_device_id, p_target_auth_session_id, p_target_connection_generation,
    p_tool_name, p_tool_args, p_metadata, p_idempotency_key, p_deadline_at
  ) on conflict (user_id, device_id, idempotency_key) do nothing returning * into v;
  if v.id is not null then
    v_inserted := true;
  else
    select * into v from public.mcp_remote_calls c
      where c.user_id = p_user_id and c.device_id = p_device_id and c.idempotency_key = p_idempotency_key;
  end if;
  if v_inserted then
    perform realtime.send(
      jsonb_build_object('call_id', v.id, 'device_id', v.device_id),
      'new_call',
      'user:' || v.user_id::text || ':device:' || v.device_id::text,
      true
    );
  end if;
  return v;
end $$;
revoke all on function public.create_mcp_remote_call_server(uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, timestamptz) from public, anon, authenticated;
grant execute on function public.create_mcp_remote_call_server(uuid, uuid, uuid, uuid, text, jsonb, jsonb, text, timestamptz) to service_role;

-- Device execution claim. Exactly one pending row can transition, and only the
-- exact Supabase session + Presence generation targeted at dispatch may win.
create or replace function public.claim_mcp_remote_call(p_call_id uuid, p_device_id uuid, p_connection_generation uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_session uuid := control_plane_private.current_session_id(); v public.mcp_remote_calls;
begin
  if v_user is null or v_session is null or p_connection_generation is null then return false; end if;
  select * into v from public.mcp_remote_calls c
    where c.id = p_call_id and c.user_id = v_user and c.device_id = p_device_id for update;
  if v.id is null or v.status <> 'pending' then return false; end if;
  if v.deadline_at <= clock_timestamp() then
    update public.mcp_remote_calls set status = 'timed_out', completed_at = clock_timestamp(), error_message = 'dispatch timed out' where id = v.id and status = 'pending';
    return false;
  end if;
  if v.target_auth_session_id <> v_session or v.target_connection_generation <> p_connection_generation
     or not control_plane_private.device_session_is_active(v.device_id) then return false; end if;
  update public.mcp_remote_calls set status = 'executing', claimed_session_id = v_session,
    claimed_connection_generation = p_connection_generation, claimed_at = clock_timestamp()
    where id = v.id and status = 'pending';
  return found;
end $$;
revoke all on function public.claim_mcp_remote_call(uuid, uuid, uuid) from public, anon;
grant execute on function public.claim_mcp_remote_call(uuid, uuid, uuid) to authenticated;

create or replace function public.complete_mcp_remote_call(
  p_call_id uuid, p_device_id uuid, p_connection_generation uuid, p_status text, p_result jsonb, p_error_message text
) returns public.mcp_remote_calls
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_session uuid := control_plane_private.current_session_id(); v public.mcp_remote_calls; v_now timestamptz := clock_timestamp();
begin
  if p_status not in ('completed', 'failed') or v_user is null or v_session is null then raise exception 'invalid completion'; end if;
  select * into v from public.mcp_remote_calls c
    where c.id = p_call_id and c.user_id = v_user and c.device_id = p_device_id for update;
  if v.id is null then return null; end if;
  if v.deadline_at <= v_now and v.status in ('pending', 'executing') then
    update public.mcp_remote_calls set status = 'timed_out', completed_at = v_now, error_message = 'dispatch timed out' where id = v.id returning * into v;
    -- This locked durable terminal transition wins the completion race.
    -- Returning NULL ensures the late worker cannot treat it as success.
    return null;
  end if;
  if v.status <> 'executing' or v.target_auth_session_id <> v_session or v.claimed_session_id <> v_session
     or v.target_connection_generation <> p_connection_generation or v.claimed_connection_generation <> p_connection_generation
     or not control_plane_private.device_session_is_active(v.device_id) then return null; end if;
  update public.mcp_remote_calls set status = p_status, result = p_result, error_message = p_error_message, completed_at = v_now
    where id = v.id and status = 'executing' returning * into v;
  perform realtime.send(
    jsonb_build_object('call_id', v.id, 'device_id', v.device_id),
    'result',
    'user:' || v.user_id::text || ':device:' || v.device_id::text,
    true
  );
  return v;
end $$;
revoke all on function public.complete_mcp_remote_call(uuid, uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.complete_mcp_remote_call(uuid, uuid, uuid, text, jsonb, text) to authenticated;

create or replace function public.expire_mcp_remote_call(p_call_id uuid)
returns public.mcp_remote_calls language plpgsql security definer set search_path = '' as $$
declare v public.mcp_remote_calls;
begin
  update public.mcp_remote_calls set status = 'timed_out', completed_at = clock_timestamp(), error_message = 'dispatch timed out'
    where id = p_call_id and user_id = auth.uid() and status in ('pending', 'executing') and deadline_at <= clock_timestamp()
    returning * into v;
  if v.id is null then select * into v from public.mcp_remote_calls c where c.id = p_call_id and c.user_id = auth.uid(); end if;
  return v;
end $$;
revoke all on function public.expire_mcp_remote_call(uuid) from public, anon;
grant execute on function public.expire_mcp_remote_call(uuid) to authenticated;

-- Realtime authorization. The control plane/device topic is intentionally
-- per-device so a same-user session cannot impersonate another device's Presence.
-- Project setting "Allow public access" must also be disabled before release.
-- Hosted Supabase: realtime.messages is owned by supabase_realtime_admin and
-- already has RLS enabled; supautils lets postgres create policies on it but
-- not ALTER it. Only enable when it is actually off.
do $rls$ begin
  if not (select relrowsecurity from pg_class where oid = 'realtime.messages'::regclass) then
    alter table realtime.messages enable row level security;
  end if;
end $rls$;
drop policy if exists mcp_realtime_receive on realtime.messages;
drop policy if exists mcp_realtime_presence_publish on realtime.messages;
create policy mcp_realtime_receive on realtime.messages
  for select to authenticated using (
    realtime.messages.extension in ('broadcast', 'presence')
    and control_plane_private.topic_user_id(realtime.topic()) = auth.uid()
    and control_plane_private.owns_active_device(control_plane_private.topic_device_id(realtime.topic()))
  );
create policy mcp_realtime_presence_publish on realtime.messages
  for insert to authenticated with check (
    realtime.messages.extension = 'presence'
    and control_plane_private.topic_user_id(realtime.topic()) = auth.uid()
    and control_plane_private.device_session_is_active(control_plane_private.topic_device_id(realtime.topic()))
  );
-- There is deliberately no authenticated Broadcast INSERT policy. new_call and
-- result doorbells originate from the database after durable transitions.
