-- Integration checks: run as project owner AFTER schema.sql, preferably in a
-- disposable Supabase project. All test rows and changes are rolled back.
-- The three auth IDs below are synthetic test fixtures, not real user IDs.
begin;

create function pg_temp.assert_true(actual boolean, label text)
returns void language plpgsql as $$
begin
  if actual is distinct from true then raise exception 'FAIL: %', label; end if;
end;
$$;

create function pg_temp.expect_error(command text, expected_code text, label text)
returns void language plpgsql as $$
begin
  begin
    execute command;
  exception when others then
    if sqlstate = expected_code then return; end if;
    raise exception 'FAIL: %; expected SQLSTATE %, received % (%)', label, expected_code, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: %; command unexpectedly succeeded', label;
end;
$$;

create function pg_temp.assert_no_rows(command text, label text)
returns void language plpgsql as $$
declare changed bigint;
begin
  begin
    execute command into changed;
  exception when insufficient_privilege then return;
  end;
  perform pg_temp.assert_true(changed = 0, label);
end;
$$;

insert into auth.users(id) values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
delete from public.tmua_members;
insert into public.tmua_members(user_id, role) values
  ('11111111-1111-4111-8111-111111111111', 'manager'),
  ('22222222-2222-4222-8222-222222222222', 'student');
update public.tmua_sync_state set revision = 0, payload = '{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"initial"}', updated_by = null where id = 'main';
select pg_temp.expect_error(
  'insert into public.tmua_members values (''33333333-3333-4333-8333-333333333333'', ''student'')',
  '23505', 'only one student membership allowed');
select pg_temp.expect_error(
  'insert into public.tmua_sync_backups(payload) values (''{}'')',
  '23514', 'owner inserts still enforce envelope constraints');
do $$
declare
  valid jsonb := '{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}';
  invalid jsonb;
begin
  for invalid in
    select valid - key from unnest(array['version', 'library', 'history', 'roadmap']) as key
    union all select jsonb_set(valid, '{history,version}', '2')
    union all select jsonb_set(valid, '{roadmap,version}', '2')
    union all select jsonb_set(valid, '{roadmap,pairs}', '[]')
    union all select jsonb_set(valid, '{history,attempts}', 'null')
    union all select valid #- '{history,version}'
    union all select valid #- '{roadmap,pairs}'
  loop
    perform pg_temp.assert_true(not public.tmua_payload_valid(invalid), 'malformed envelope rejected');
  end loop;
end;
$$;

select pg_temp.assert_true(
  (select not public and file_size_limit = 52428800 and allowed_mime_types = array['application/pdf']
   from storage.buckets where id = 'tmua-pdfs'), 'bucket is private and restricted to 50 MiB PDFs');

set local role anon;
set local request.jwt.claim.sub = '';
select pg_temp.expect_error('select * from public.tmua_members', '42501', 'anonymous membership read denied');
select pg_temp.expect_error('select * from public.tmua_sync_state', '42501', 'anonymous state read denied');
select pg_temp.expect_error('select * from public.tmua_sync_backups', '42501', 'anonymous backup read denied');
select pg_temp.expect_error('select * from public.tmua_pdf_versions', '42501', 'anonymous PDF metadata read denied');
select pg_temp.assert_no_rows(
  'select count(*) from storage.objects where bucket_id = ''tmua-pdfs''', 'anonymous PDF object read denied');
select pg_temp.expect_error('select public.tmua_write_state(0, ''{}''::jsonb)', '42501', 'anonymous state RPC denied');
select pg_temp.expect_error('select public.tmua_save_backup(''{}''::jsonb)', '42501', 'anonymous backup RPC denied');

set local role authenticated;
set local request.jwt.claim.sub = '33333333-3333-4333-8333-333333333333';
select pg_temp.assert_true((select count(*) = 0 from public.tmua_members), 'unapproved user has no membership');
select pg_temp.assert_true((select count(*) = 0 from public.tmua_sync_state), 'unapproved user cannot read state');
select pg_temp.assert_true((select count(*) = 0 from public.tmua_sync_backups), 'unapproved user cannot read backups');
select pg_temp.assert_true((select count(*) = 0 from public.tmua_pdf_versions), 'unapproved user cannot read PDF metadata');
select pg_temp.assert_true(
  (select count(*) = 0 from storage.objects where bucket_id = 'tmua-pdfs'), 'unapproved user cannot read PDF objects');
select pg_temp.expect_error('select public.tmua_write_state(0, ''{}''::jsonb)', '42501', 'unapproved state write denied');
select pg_temp.expect_error('select public.tmua_save_backup(''{}''::jsonb)', '42501', 'unapproved backup write denied');
select pg_temp.expect_error(
  'insert into public.tmua_members values (auth.uid(), ''manager'')', '42501', 'self role assignment denied');

set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select pg_temp.assert_true((select count(*) = 1 from public.tmua_members), 'manager reads only own membership');
select pg_temp.assert_true(public.tmua_is_manager(), 'manager helper recognizes manager');
select pg_temp.assert_true(
  public.tmua_write_state(0, '{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"manager"}') @> '{"revision":1,"payload":{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"manager"}}',
  'successful manager write increments revision and returns saved payload');
select pg_temp.assert_true((select revision = 1 and updated_by = auth.uid() from public.tmua_sync_state), 'state stamps writer');
select pg_temp.expect_error(
  'update public.tmua_sync_state set payload = ''{}''::jsonb', '42501', 'direct state update denied');
select pg_temp.expect_error(
  'insert into public.tmua_sync_state(id, payload) values (''other'', ''{}''::jsonb)', '42501', 'direct state insert denied');
select pg_temp.expect_error('delete from public.tmua_sync_state', '42501', 'direct state delete denied');
select pg_temp.expect_error('update public.tmua_members set role = ''student''', '42501', 'manager role mutation denied');
select pg_temp.expect_error('insert into public.tmua_sync_backups(payload) values (''{}'')', '42501', 'direct backup insert denied');
select public.tmua_save_backup('{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"manager"}');

insert into storage.objects(bucket_id, name)
values ('tmua-pdfs', '11111111-2222-4333-8444-555555555555.pdf');
insert into public.tmua_pdf_versions(id, document_key, title, filename, object_path, sha256, bytes)
values ('44444444-4444-4444-8444-444444444444', 'schema-test', 'Test document', 'test.pdf',
  '11111111-2222-4333-8444-555555555555.pdf', repeat('a', 64), 1);
select pg_temp.assert_true(
  (select count(*) = 1 from public.tmua_pdf_versions where id = '44444444-4444-4444-8444-444444444444'),
  'manager can insert and read PDF metadata');
select pg_temp.expect_error(
  'update public.tmua_pdf_versions set title = ''Replaced''', '42501', 'PDF metadata update denied');
select pg_temp.expect_error('delete from public.tmua_pdf_versions', '42501', 'PDF metadata deletion denied');
select pg_temp.expect_error(
  'insert into storage.objects(bucket_id,name) values (''tmua-pdfs'', ''bad.txt'')',
  '42501', 'non-UUID PDF object path denied');
select pg_temp.expect_error(
  'insert into storage.objects(bucket_id,name) values (''tmua-pdfs'', ''11111111-2222-4333-8444-555555555555.pdf'')',
  '23505', 'object paths cannot be overwritten with another insert');
select pg_temp.assert_no_rows(
  'with changed as (update storage.objects set name = ''66666666-6666-4666-8666-666666666666.pdf'' where bucket_id = ''tmua-pdfs'' returning id) select count(*) from changed',
  'storage update denied');
select pg_temp.assert_no_rows(
  'with changed as (delete from storage.objects where bucket_id = ''tmua-pdfs'' returning id) select count(*) from changed',
  'storage delete denied');
select pg_temp.expect_error(
  'insert into public.tmua_pdf_versions(document_key,title,filename,object_path,sha256,bytes,created_by) values (''test'',''Test'',''test.pdf'',''77777777-7777-4777-8777-777777777777.pdf'',repeat(''a'',64),1,''22222222-2222-4222-8222-222222222222'')',
  '42501', 'manager cannot spoof metadata creator');
select pg_temp.expect_error(
  'insert into public.tmua_pdf_versions(document_key,title,filename,object_path,sha256,bytes) values (''test'',''Test'',''test.pdf'',''77777777-7777-4777-8777-777777777777.pdf'',repeat(''a'',64),52428801)',
  '23514', 'PDF metadata size limit enforced');

set local request.jwt.claim.sub = '22222222-2222-4222-8222-222222222222';
select pg_temp.assert_true((select count(*) = 1 from public.tmua_members), 'student reads only own membership');
select pg_temp.assert_true(not public.tmua_is_manager() and public.tmua_is_member(), 'student is member but not manager');
select pg_temp.assert_true((select revision = 1 from public.tmua_sync_state), 'student reads shared state');
select set_config('tmua_test.conflict_snapshot', (select row_to_json(s)::text from public.tmua_sync_state as s), true);
select pg_temp.expect_error(
  'select public.tmua_write_state(0, ''{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"stale"}''::jsonb)', '40001', 'stale revision conflicts');
select pg_temp.assert_true(
  (select row_to_json(s)::text = current_setting('tmua_test.conflict_snapshot') from public.tmua_sync_state as s),
  'conflict leaves state unchanged');
select pg_temp.assert_true(
  public.tmua_write_state(1, '{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"student"}') ->> 'revision' = '2',
  'student can save against the current revision');
select pg_temp.expect_error('select public.tmua_write_state(-1, ''{}''::jsonb)', '22023', 'negative revision denied');
select pg_temp.expect_error('select public.tmua_write_state(2, ''[]''::jsonb)', '22023', 'non-object payload denied');
select pg_temp.expect_error('select public.tmua_write_state(2, null)', '22023', 'null payload denied');
select pg_temp.expect_error('select public.tmua_write_state(2, ''{}''::jsonb)', '22023', 'missing envelope fields denied');
select pg_temp.expect_error('select public.tmua_save_backup(''{"version":1,"library":null,"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}''::jsonb)', '22023', 'JSON null library denied');
select pg_temp.expect_error('select public.tmua_write_state(2, ''{"version":2,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}''::jsonb)', '22023', 'unsupported envelope version denied');
select pg_temp.expect_error('select public.tmua_write_state(2, ''{"version":1,"library":{},"history":{"version":1,"attempts":{}},"roadmap":{"version":1,"pairs":{}}}''::jsonb)', '22023', 'non-array attempts denied');
select pg_temp.expect_error('select public.tmua_payload_valid(''{}''::jsonb)', '42501', 'payload helper is owner-only');
select pg_temp.expect_error(
  'select public.tmua_write_state(2, ''{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}''::jsonb || jsonb_build_object(''large'', repeat(''a'', 5242880)))',
  '22023', 'oversize sync payload denied');
select pg_temp.expect_error(
  'select public.tmua_save_backup(''{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}}}''::jsonb || jsonb_build_object(''large'', repeat(''a'', 5242880)))',
  '22023', 'oversize backup denied');
select pg_temp.assert_true((select revision = 2 from public.tmua_sync_state), 'invalid writes do not advance revision');
select public.tmua_save_backup('{"version":1,"library":{},"history":{"version":1,"attempts":[]},"roadmap":{"version":1,"pairs":{}},"schema_test":"student"}');
select pg_temp.assert_true((select count(*) = 1 from public.tmua_sync_backups), 'student reads own backup only');
select pg_temp.assert_true((select count(*) = 0 from public.tmua_pdf_versions), 'student cannot list PDF metadata');
select pg_temp.assert_true(
  (select count(*) = 0 from storage.objects where bucket_id = 'tmua-pdfs'), 'student cannot list or read PDF objects');
select pg_temp.expect_error(
  'insert into storage.objects(bucket_id,name) values (''tmua-pdfs'', ''88888888-8888-4888-8888-888888888888.pdf'')',
  '42501', 'student cannot upload PDF');
select pg_temp.expect_error(
  'insert into public.tmua_pdf_versions(document_key,title,filename,object_path,sha256,bytes) values (''test'',''Test'',''test.pdf'',''88888888-8888-4888-8888-888888888888.pdf'',repeat(''a'',64),1)',
  '42501', 'student cannot register PDF metadata');

set local request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
select pg_temp.assert_true(
  (select count(*) = 2 from public.tmua_sync_backups where payload ->> 'schema_test' in ('manager', 'student')),
  'manager reads both users conflict backups');
select pg_temp.assert_true(
  (select count(*) = 1 from storage.objects where bucket_id = 'tmua-pdfs' and name = '11111111-2222-4333-8444-555555555555.pdf'),
  'original PDF remains after denied mutations');

reset role;
rollback;
select 'TMUA RLS integration checks passed; test changes rolled back.' as result;
