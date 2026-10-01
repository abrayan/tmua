-- Run after schema.sql as the trusted project owner. This adds private guided
-- papers only; it does not change membership, progress, scores or account RPCs.
-- Upload both reviewed objects first with upsert=false, then insert both rows
-- in one transaction. A new teaching version is a new immutable edition path.
begin;

create or replace function public.tmua_guided_metadata_valid(
  value jsonb, paper_id text, pair_id text, paper_number smallint
)
returns boolean
language plpgsql immutable set search_path = ''
as $$
begin
  if jsonb_typeof(value) is distinct from 'object' then return false; end if;
  return coalesce(
    value ->> 'visibility' = 'private'
    and value ->> 'format' = 'tmua-paper-v1'
    and value -> 'version' = '1'::jsonb
    and value ->> 'id' = paper_id
    and value ->> 'pairId' = pair_id
    and value -> 'paper' = to_jsonb(paper_number)
    and value -> 'questionCount' = '20'::jsonb
    and value ->> 'practicePolicy' = 'after-miss-up-to-3'
    and jsonb_typeof(value -> 'title') = 'string'
    and char_length(btrim(value ->> 'title')) between 1 and 200
    and jsonb_typeof(value -> 'source') = 'string'
    and char_length(btrim(value ->> 'source')) between 1 and 300
    and jsonb_typeof(value -> 'description') = 'string'
    and char_length(value ->> 'description') <= 2000
    and not (value ? 'href')
    and octet_length(value::text) <= 16384,
    false
  );
end;
$$;

create or replace function public.tmua_guided_mapping_valid(
  value jsonb, paper_id text, paper_number smallint
)
returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  question jsonb;
  revision jsonb;
begin
  if jsonb_typeof(value) is distinct from 'object'
    or jsonb_typeof(value -> 'paper') is distinct from 'object'
    or jsonb_typeof(value #> '{paper,questions}') is distinct from 'array'
    or jsonb_typeof(value #> '{paper,contentRevisions}') is distinct from 'array'
  then return false; end if;
  if not coalesce(
    value ->> 'versionId' ~ '^[a-z0-9][a-z0-9_-]{0,79}$'
    and value ->> 'sha256' ~ '^[0-9a-f]{64}$'
    and value #>> '{paper,id}' = paper_id
    and value #> '{paper,paper}' = to_jsonb(paper_number)
    and value #> '{paper,version}' = '1'::jsonb
    and jsonb_typeof(value #> '{paper,title}') = 'string'
    and char_length(btrim(value #>> '{paper,title}')) between 1 and 200
    and jsonb_array_length(value #> '{paper,questions}') = 20
    and jsonb_array_length(value #> '{paper,contentRevisions}') between 1 and 100
    and octet_length(value::text) <= 262144,
    false
  ) then return false; end if;
  for revision in select jsonb_array_elements(value #> '{paper,contentRevisions}') loop
    if jsonb_typeof(revision) is distinct from 'number'
      or revision::text !~ '^[1-9][0-9]{0,8}$'
    then return false; end if;
  end loop;
  for question in select jsonb_array_elements(value #> '{paper,questions}') loop
    if jsonb_typeof(question) is distinct from 'object'
      or jsonb_typeof(question -> 'lessonIds') is distinct from 'array'
    then return false; end if;
    if not coalesce(
      jsonb_typeof(question -> 'sourceId') = 'string'
      and char_length(question ->> 'sourceId') between 1 and 120
      and jsonb_typeof(question -> 'canonicalSourceId') = 'string'
      and char_length(question ->> 'canonicalSourceId') between 1 and 120
      and jsonb_typeof(question -> 'knowledgePattern') = 'string'
      and char_length(btrim(question ->> 'knowledgePattern')) between 1 and 2000
      and jsonb_array_length(question -> 'lessonIds') between 1 and 30,
      false
    ) then return false; end if;
    if exists (
      select 1 from jsonb_array_elements(question -> 'lessonIds') as lesson(id)
      where jsonb_typeof(id) is distinct from 'string'
        or (id #>> '{}') !~ '^p[12]-[a-z0-9][a-z0-9-]{0,119}$'
    ) then return false; end if;
  end loop;
  return (
    select count(distinct questions.question ->> 'sourceId') = 20
    from jsonb_array_elements(value #> '{paper,questions}') as questions(question)
  );
end;
$$;

revoke all on function public.tmua_guided_metadata_valid(jsonb,text,text,smallint) from public, anon, authenticated;
revoke all on function public.tmua_guided_mapping_valid(jsonb,text,smallint) from public, anon, authenticated;

create table if not exists public.tmua_guided_editions (
  paper_id text not null check (paper_id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  edition_id text not null check (edition_id ~ '^[a-z0-9][a-z0-9-]{0,79}$' and edition_id <> 'original'),
  pair_id text not null check (pair_id ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  paper_number smallint not null check (paper_number in (1, 2)),
  object_path text not null unique check (object_path = paper_id || '/' || edition_id || '.html'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb not null check (public.tmua_guided_metadata_valid(metadata,paper_id,pair_id,paper_number)),
  concept_mapping jsonb not null check (public.tmua_guided_mapping_valid(concept_mapping,paper_id,paper_number)),
  created_at timestamptz not null default now(),
  primary key (paper_id, edition_id),
  unique (pair_id, edition_id, paper_number)
);

create index if not exists tmua_guided_pair_created_idx
  on public.tmua_guided_editions (pair_id, created_at desc, edition_id);

-- No browser role, including the manager, can prepare or mutate teaching files.
alter table public.tmua_guided_editions enable row level security;
revoke all on table public.tmua_guided_editions from public, anon, authenticated, service_role;
grant select on table public.tmua_guided_editions to authenticated;
grant select, insert on table public.tmua_guided_editions to service_role;
grant execute on function public.tmua_guided_metadata_valid(jsonb,text,text,smallint) to service_role;
grant execute on function public.tmua_guided_mapping_valid(jsonb,text,smallint) to service_role;

drop policy if exists tmua_guided_read_member on public.tmua_guided_editions;
create policy tmua_guided_read_member on public.tmua_guided_editions
  for select to authenticated using ((select public.tmua_is_member()));

create or replace function public.tmua_guided_require_stable_identity()
returns trigger
language plpgsql set search_path = ''
as $$
declare
  earlier public.tmua_guided_editions%rowtype;
begin
  -- Serialize releases of the same pair, including attempted relabelling of a
  -- paper. Immutable rows then preserve the identity seen by old attempts.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.pair_id, 71930));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.paper_id, 71931));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.concept_mapping ->> 'versionId', 71932));
  if exists (
    select 1 from public.tmua_guided_editions as edition
    where edition.concept_mapping ->> 'versionId' = new.concept_mapping ->> 'versionId'
      and (edition.pair_id is distinct from new.pair_id
        or (edition.paper_id = new.paper_id and edition.concept_mapping is distinct from new.concept_mapping))
  ) then
    raise exception using errcode = '23514', message = 'TMUA_GUIDED_MAPPING_VERSION_CHANGED';
  end if;
  select * into earlier from public.tmua_guided_editions
    where paper_id = new.paper_id or (pair_id = new.pair_id and paper_number = new.paper_number)
    order by created_at, edition_id limit 1;
  if found and (
    earlier.paper_id is distinct from new.paper_id
    or earlier.pair_id is distinct from new.pair_id
    or earlier.paper_number is distinct from new.paper_number
    or earlier.metadata ->> 'title' is distinct from new.metadata ->> 'title'
    or earlier.metadata ->> 'source' is distinct from new.metadata ->> 'source'
    or (select jsonb_agg(jsonb_build_array(q ->> 'sourceId', q ->> 'canonicalSourceId') order by n)
        from jsonb_array_elements(earlier.concept_mapping #> '{paper,questions}') with ordinality as item(q,n))
      is distinct from
       (select jsonb_agg(jsonb_build_array(q ->> 'sourceId', q ->> 'canonicalSourceId') order by n)
        from jsonb_array_elements(new.concept_mapping #> '{paper,questions}') with ordinality as item(q,n))
  ) then
    raise exception using errcode = '23514', message = 'TMUA_GUIDED_IDENTITY_CHANGED';
  end if;
  return new;
end;
$$;

create or replace function public.tmua_guided_check_pair()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (
    select count(*) <> 2 or count(distinct paper_number) <> 2
      or count(distinct paper_id) <> 2 or count(distinct sha256) <> 2
      or count(distinct created_at) <> 1
      or count(distinct concept_mapping ->> 'versionId') <> 1
    from public.tmua_guided_editions
    where pair_id = new.pair_id and edition_id = new.edition_id
  ) or exists (
    select 1 from public.tmua_guided_editions as edition
    where edition.pair_id = new.pair_id and edition.edition_id = new.edition_id
      and not exists (
        select 1 from storage.objects as object
        where object.bucket_id = 'tmua-guided' and object.name = edition.object_path
      )
  ) then
    raise exception using errcode = '23514', message = 'TMUA_GUIDED_PAIR_INCOMPLETE';
  end if;
  return null;
end;
$$;

create or replace function public.tmua_guided_reject_mutation()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'TMUA_GUIDED_EDITION_IMMUTABLE';
end;
$$;

revoke all on function public.tmua_guided_require_stable_identity() from public, anon, authenticated, service_role;
revoke all on function public.tmua_guided_check_pair() from public, anon, authenticated, service_role;
revoke all on function public.tmua_guided_reject_mutation() from public, anon, authenticated, service_role;

drop trigger if exists tmua_guided_stable_identity on public.tmua_guided_editions;
create trigger tmua_guided_stable_identity before insert on public.tmua_guided_editions
  for each row execute function public.tmua_guided_require_stable_identity();
drop trigger if exists tmua_guided_complete_pair on public.tmua_guided_editions;
create constraint trigger tmua_guided_complete_pair after insert on public.tmua_guided_editions
  deferrable initially deferred for each row execute function public.tmua_guided_check_pair();
drop trigger if exists tmua_guided_no_mutation on public.tmua_guided_editions;
create trigger tmua_guided_no_mutation before update or delete on public.tmua_guided_editions
  for each row execute function public.tmua_guided_reject_mutation();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tmua-guided', 'tmua-guided', false, 15728640, array['text/html'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tmua_guided_objects_read_member on storage.objects;
create policy tmua_guided_objects_read_member on storage.objects
  for select to authenticated using (
    bucket_id = 'tmua-guided' and (select public.tmua_is_member())
    and exists (select 1 from public.tmua_guided_editions as edition where edition.object_path = name)
  );

-- These triggers affect only this new bucket. They also block a trusted worker
-- accidentally overwriting a version. Unpublished objects are not browser-readable.
create or replace function public.tmua_guided_object_guard()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.bucket_id = 'tmua-guided'
      and new.name !~ '^[a-z0-9][a-z0-9_-]{0,79}/[a-z0-9][a-z0-9-]{0,79}\.html$'
    then raise exception using errcode = '23514', message = 'TMUA_GUIDED_OBJECT_PATH_INVALID'; end if;
    return new;
  end if;
  if old.bucket_id = 'tmua-guided' or (tg_op = 'UPDATE' and new.bucket_id = 'tmua-guided') then
    raise exception using errcode = '55000', message = 'TMUA_GUIDED_OBJECT_IMMUTABLE';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.tmua_guided_object_guard() from public, anon, authenticated, service_role;
drop trigger if exists tmua_guided_object_immutable on storage.objects;
create trigger tmua_guided_object_immutable before insert or update or delete on storage.objects
  for each row execute function public.tmua_guided_object_guard();

-- No client INSERT/UPDATE/DELETE storage policy is introduced. Only a trusted
-- project owner/service worker can upload prepared files. No worker is implied.
commit;
