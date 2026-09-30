-- Run after the account-progress v2 migration, before publishing the paired uploader.
-- Safe to rerun: original PDF rows remain unchanged and readable as legacy entries.
begin;

-- Required PDF pairs. Keep this block identical in schema.sql and this migration.
alter table public.tmua_pdf_versions
  add column if not exists pair_id uuid,
  add column if not exists paper_number smallint;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.tmua_pdf_versions'::regclass
      and conname = 'tmua_pdf_versions_pair_fields_check'
  ) then
    alter table public.tmua_pdf_versions add constraint tmua_pdf_versions_pair_fields_check
      check (
        (pair_id is null and paper_number is null)
        or (pair_id is not null and paper_number is not null and paper_number in (1, 2))
      );
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.tmua_pdf_versions'::regclass
      and conname = 'tmua_pdf_versions_pair_paper_unique'
  ) then
    alter table public.tmua_pdf_versions add constraint tmua_pdf_versions_pair_paper_unique
      unique (pair_id, paper_number);
  end if;
end;
$$;

-- Nullable columns preserve legacy rows, but cannot be used for new single uploads.
create or replace function public.tmua_require_pdf_pair()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.pair_id is null or new.paper_number is null then
    raise exception using errcode = '23514', message = 'TMUA_PDF_PAIR_REQUIRED';
  end if;
  return new;
end;
$$;

-- PostgREST inserts the two-row JSON array in one transaction. Validate at commit
-- so both rows exist; separate single-row requests always fail without saving.
-- The unique paper slots also prevent extending a previously completed pair.
create or replace function public.tmua_check_pdf_pair()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if (
    select count(*) <> 2 or count(distinct paper_number) <> 2
      or min(paper_number) <> 1 or max(paper_number) <> 2
      or count(distinct sha256) <> 2
    from public.tmua_pdf_versions where pair_id = new.pair_id
  ) or exists (
    select 1 from public.tmua_pdf_versions
    where pair_id = new.pair_id and (
      document_key is distinct from new.document_key
      or title is distinct from new.title
      or created_by is distinct from new.created_by
    )
  ) then
    raise exception using errcode = '23514', message = 'TMUA_PDF_PAIR_INVALID';
  end if;
  return null;
end;
$$;

-- Trigger execution does not require callers to execute these functions directly.
revoke all on function public.tmua_require_pdf_pair() from public, anon, authenticated;
revoke all on function public.tmua_check_pdf_pair() from public, anon, authenticated;

drop trigger if exists tmua_pdf_pair_required on public.tmua_pdf_versions;
create trigger tmua_pdf_pair_required
  before insert on public.tmua_pdf_versions
  for each row execute function public.tmua_require_pdf_pair();

drop trigger if exists tmua_pdf_pair_complete on public.tmua_pdf_versions;
create constraint trigger tmua_pdf_pair_complete
  after insert on public.tmua_pdf_versions
  deferrable initially deferred
  for each row execute function public.tmua_check_pdf_pair();
-- End required PDF pairs.

commit;
