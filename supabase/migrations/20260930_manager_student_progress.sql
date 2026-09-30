-- Run as the trusted project owner after the account-progress v2 migration.
-- Adds only a read-only manager view; existing progress and write APIs are unchanged.
begin;

-- Manager student progress. Keep this block identical in schema.sql and its migration.
-- This separate view does not initialize, copy, or change either account's state.
create or replace function public.tmua_read_student_progress()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  snapshot jsonb;
begin
  if not public.tmua_is_manager() then
    raise exception using errcode = '42501', message = 'TMUA_MANAGER_REQUIRED';
  end if;

  select jsonb_build_object(
    'student', jsonb_build_object('user_id', member.user_id),
    'revision', saved.revision, 'payload', saved.payload,
    'updated_at', saved.updated_at
  ) into snapshot
  from public.tmua_members as member
  left join public.tmua_sync_state_v2 as saved on saved.user_id = member.user_id
  where member.role = 'student';

  return coalesce(snapshot, jsonb_build_object(
    'student', null, 'revision', null, 'payload', null, 'updated_at', null
  ));
end;
$$;

revoke all on function public.tmua_read_student_progress() from public, anon, authenticated;
grant execute on function public.tmua_read_student_progress() to authenticated;
-- End manager student progress.

commit;
