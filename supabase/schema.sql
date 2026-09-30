-- Run as the trusted project owner in the Supabase SQL Editor.
-- Account-isolated progress: at most one manager and one student.
-- Re-running this file preserves every account row and the legacy archive.
-- No passwords, real email addresses, auth user IDs, or secret keys belong here.
begin;

-- Owner-only, side-effect-free validation also protects trusted SQL inserts.
create or replace function public.tmua_payload_valid(value jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(
    jsonb_typeof(value) = 'object' and value -> 'version' = '1'::jsonb
    and jsonb_typeof(value -> 'library') = 'object'
    and value #> '{history,version}' = '1'::jsonb
    and jsonb_typeof(value #> '{history,attempts}') = 'array'
    and value #> '{roadmap,version}' = '1'::jsonb
    and jsonb_typeof(value #> '{roadmap,pairs}') = 'object'
    and octet_length(value::text) <= 5242880,
    false
  );
$$;
revoke all on function public.tmua_payload_valid(jsonb) from public, anon, authenticated;

create table if not exists public.tmua_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null unique check (role in ('manager', 'student'))
);

create table if not exists public.tmua_sync_state (
  id text primary key default 'main' check (id = 'main'),
  revision bigint not null default 0 check (revision >= 0),
  payload jsonb not null check (public.tmua_payload_valid(payload)),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.tmua_sync_backups (
  id uuid primary key default gen_random_uuid(),
  payload jsonb not null check (public.tmua_payload_valid(payload)),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- The two original shared tables are retained as an owner-only archive.
-- Their contents have no reliable account attribution and are never copied into v2.
create table if not exists public.tmua_sync_state_v2 (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  payload jsonb not null check (public.tmua_payload_valid(payload)),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create table if not exists public.tmua_sync_backups_v2 (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  payload jsonb not null check (public.tmua_payload_valid(payload)),
  created_at timestamptz not null default now()
);

create table if not exists public.tmua_pdf_versions (
  id uuid primary key default gen_random_uuid(),
  document_key text not null check (document_key ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  filename text not null check (
    char_length(filename) between 5 and 255
    and filename ~* '\.pdf$'
    and filename !~ '[/\\]'
  ),
  object_path text not null unique check (
    object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  ),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes bigint not null check (bytes between 1 and 52428800),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null default auth.uid()
);

create index if not exists tmua_pdf_versions_document_created_idx
  on public.tmua_pdf_versions (document_key, created_at desc);
create index if not exists tmua_sync_backups_creator_created_idx
  on public.tmua_sync_backups (created_by, created_at desc);

alter table public.tmua_members enable row level security;
alter table public.tmua_sync_state enable row level security;
alter table public.tmua_sync_backups enable row level security;
alter table public.tmua_pdf_versions enable row level security;
alter table public.tmua_sync_state_v2 enable row level security;
alter table public.tmua_sync_backups_v2 enable row level security;

-- Clients cannot assign roles or directly mutate progress/backup rows.
revoke all on table public.tmua_members from public, anon, authenticated;
revoke all on table public.tmua_sync_state from public, anon, authenticated;
revoke all on table public.tmua_sync_backups from public, anon, authenticated;
revoke all on table public.tmua_pdf_versions from public, anon, authenticated;
grant select on table public.tmua_members to authenticated;
revoke all on table public.tmua_sync_state_v2 from public, anon, authenticated;
revoke all on table public.tmua_sync_backups_v2 from public, anon, authenticated;
grant select on table public.tmua_sync_state_v2 to authenticated;
grant select on table public.tmua_sync_backups_v2 to authenticated;
grant select, insert on table public.tmua_pdf_versions to authenticated;

-- No user argument is accepted: callers can inspect only their own membership.
create or replace function public.tmua_is_member()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tmua_members where user_id = (select auth.uid())
  );
$$;

create or replace function public.tmua_is_manager()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.tmua_members
    where user_id = (select auth.uid()) and role = 'manager'
  );
$$;

revoke all on function public.tmua_is_member() from public, anon, authenticated;
revoke all on function public.tmua_is_manager() from public, anon, authenticated;
grant execute on function public.tmua_is_member() to authenticated;
grant execute on function public.tmua_is_manager() to authenticated;

drop policy if exists tmua_members_read_self on public.tmua_members;
create policy tmua_members_read_self on public.tmua_members
  for select to authenticated using (user_id = (select auth.uid()));

-- Remove v1 shared access. Membership never confers access to another user's
-- current progress or backup, including for the manager account.
drop policy if exists tmua_state_read_member on public.tmua_sync_state;
drop policy if exists tmua_backups_read_owner_or_manager on public.tmua_sync_backups;

drop policy if exists tmua_state_read_self_v2 on public.tmua_sync_state_v2;
create policy tmua_state_read_self_v2 on public.tmua_sync_state_v2
  for select to authenticated using (
    (select public.tmua_is_member()) and user_id = (select auth.uid())
  );

drop policy if exists tmua_backups_read_self_v2 on public.tmua_sync_backups_v2;
create policy tmua_backups_read_self_v2 on public.tmua_sync_backups_v2
  for select to authenticated using (
    (select public.tmua_is_member()) and user_id = (select auth.uid())
  );

create index if not exists tmua_sync_backups_v2_user_created_idx
  on public.tmua_sync_backups_v2 (user_id, created_at desc);

drop policy if exists tmua_pdf_read_manager on public.tmua_pdf_versions;
create policy tmua_pdf_read_manager on public.tmua_pdf_versions
  for select to authenticated using ((select public.tmua_is_manager()));

drop policy if exists tmua_pdf_insert_manager on public.tmua_pdf_versions;
create policy tmua_pdf_insert_manager on public.tmua_pdf_versions
  for insert to authenticated with check (
    (select public.tmua_is_manager()) and created_by = (select auth.uid())
  );

-- Freeze obsolete clients. Revoked grants deny browser calls, and the function
-- bodies also refuse writes if a trusted caller still invokes the old API.
create or replace function public.tmua_write_state(expected_revision bigint, new_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'TMUA_ACCOUNT_UPGRADE_REQUIRED';
end;
$$;

create or replace function public.tmua_save_backup(new_payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'TMUA_ACCOUNT_UPGRADE_REQUIRED';
end;
$$;

revoke all on function public.tmua_write_state(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.tmua_save_backup(jsonb) from public, anon, authenticated;

-- All ownership comes from the authenticated session. There is intentionally
-- no owner/user argument in any account API.
create or replace function public.tmua_read_state_v2()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  saved public.tmua_sync_state_v2%rowtype;
begin
  if not public.tmua_is_member() then
    raise exception using errcode = '42501', message = 'TMUA_MEMBER_REQUIRED';
  end if;
  insert into public.tmua_sync_state_v2 (user_id, revision, payload)
  values (auth.uid(), 0, '{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}'::jsonb)
  on conflict (user_id) do nothing;

  select * into strict saved from public.tmua_sync_state_v2
  where user_id = auth.uid();
  return jsonb_build_object(
    'user_id', saved.user_id, 'revision', saved.revision,
    'payload', saved.payload, 'updated_at', saved.updated_at
  );
end;
$$;

-- One UPDATE compares and mutates under the same row lock, scoped to auth.uid.
-- Concurrent stale revisions fail without changing either account's data.
create or replace function public.tmua_write_state_v2(expected_revision bigint, new_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  saved public.tmua_sync_state_v2%rowtype;
begin
  if not public.tmua_is_member() then
    raise exception using errcode = '42501', message = 'TMUA_MEMBER_REQUIRED';
  end if;
  if expected_revision is null or expected_revision < 0 then
    raise exception using errcode = '22023', message = 'TMUA_INVALID_REVISION';
  end if;
  if not public.tmua_payload_valid(new_payload) then
    raise exception using errcode = '22023', message = 'TMUA_INVALID_PAYLOAD';
  end if;

  perform public.tmua_read_state_v2();
  update public.tmua_sync_state_v2
  set revision = revision + 1, payload = new_payload,
      updated_at = clock_timestamp(), updated_by = auth.uid()
  where user_id = auth.uid() and revision = expected_revision
  returning * into saved;

  if not found then
    raise exception using errcode = '40001', message = 'TMUA_SYNC_CONFLICT';
  end if;
  return jsonb_build_object(
    'user_id', saved.user_id, 'revision', saved.revision,
    'payload', saved.payload, 'updated_at', saved.updated_at
  );
end;
$$;

create or replace function public.tmua_save_backup_v2(new_payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  backup_id uuid;
begin
  if not public.tmua_is_member() then
    raise exception using errcode = '42501', message = 'TMUA_MEMBER_REQUIRED';
  end if;
  if not public.tmua_payload_valid(new_payload) then
    raise exception using errcode = '22023', message = 'TMUA_INVALID_PAYLOAD';
  end if;
  insert into public.tmua_sync_backups_v2 (user_id, payload)
  values (auth.uid(), new_payload) returning id into backup_id;
  return backup_id;
end;
$$;

-- Explicit manager review of the frozen shared archive. Returning this snapshot
-- never assigns it to an account or changes a v2 progress row.
create or replace function public.tmua_read_legacy_state_v2()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  saved public.tmua_sync_state%rowtype;
begin
  if not public.tmua_is_manager() then
    raise exception using errcode = '42501', message = 'TMUA_MANAGER_REQUIRED';
  end if;
  select * into saved from public.tmua_sync_state where id = 'main';
  if not found then return null; end if;
  return jsonb_build_object(
    'revision', saved.revision, 'payload', saved.payload,
    'updated_at', saved.updated_at, 'updated_by', saved.updated_by
  );
end;
$$;

revoke all on function public.tmua_read_state_v2() from public, anon, authenticated;
revoke all on function public.tmua_write_state_v2(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.tmua_save_backup_v2(jsonb) from public, anon, authenticated;
revoke all on function public.tmua_read_legacy_state_v2() from public, anon, authenticated;
grant execute on function public.tmua_read_state_v2() to authenticated;
grant execute on function public.tmua_write_state_v2(bigint, jsonb) to authenticated;
grant execute on function public.tmua_save_backup_v2(jsonb) to authenticated;
grant execute on function public.tmua_read_legacy_state_v2() to authenticated;

-- Uploads always use a fresh UUID.pdf. A new version is a new object and row.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tmua-pdfs', 'tmua-pdfs', false, 52428800, array['application/pdf'])
on conflict (id) do update set
  public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tmua_pdf_objects_read_manager on storage.objects;
create policy tmua_pdf_objects_read_manager on storage.objects
  for select to authenticated using (
    bucket_id = 'tmua-pdfs' and (select public.tmua_is_manager())
  );

drop policy if exists tmua_pdf_objects_insert_manager on storage.objects;
create policy tmua_pdf_objects_insert_manager on storage.objects
  for insert to authenticated with check (
    bucket_id = 'tmua-pdfs' and (select public.tmua_is_manager())
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

-- Intentionally no storage UPDATE/DELETE policy and no public/anon policy.
commit;
