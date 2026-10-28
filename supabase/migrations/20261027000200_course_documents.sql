-- Private course files and retryable ingestion state.
create table if not exists public.course_documents (
  id uuid primary key,
  course_id uuid not null references public.courses (id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  file_name text not null check (
    length(file_name) between 1 and 255
    and position('/' in file_name) = 0
    and position(chr(92) in file_name) = 0
  ),
  mime_type text not null check (
    mime_type in (
      'application/pdf',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    )
  ),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'ready', 'failed')),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    storage_path = course_id::text || '/' || id::text || '/' || file_name
  )
);

create index if not exists course_documents_course_id_idx
  on public.course_documents (course_id, created_at desc);

create table if not exists public.document_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.course_documents (id) on delete cascade,
  status text not null default 'queued'
    check (status in ('queued', 'processing', 'succeeded', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  next_attempt_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (attempt_count <= max_attempts)
);

create index if not exists document_ingestion_jobs_ready_idx
  on public.document_ingestion_jobs (next_attempt_at, created_at)
  where status = 'queued';

create unique index if not exists document_ingestion_jobs_one_active_per_document
  on public.document_ingestion_jobs (document_id)
  where status in ('queued', 'processing');

create or replace function private.user_can_access_course_folder(course_folder text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when course_folder ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.user_can_access_course(course_folder::uuid)
    else false
  end;
$$;

create or replace function private.user_can_manage_course_folder(course_folder text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when course_folder ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then private.user_can_manage_course(course_folder::uuid)
    else false
  end;
$$;

revoke all on function private.user_can_access_course_folder(text) from public;
revoke all on function private.user_can_manage_course_folder(text) from public;
grant execute on function private.user_can_access_course_folder(text) to authenticated;
grant execute on function private.user_can_manage_course_folder(text) to authenticated;

alter table public.course_documents enable row level security;
alter table public.document_ingestion_jobs enable row level security;

grant select on public.course_documents to authenticated;
grant insert (
  id, course_id, title, file_name, mime_type, size_bytes, sha256, storage_path, created_by
) on public.course_documents to authenticated;
grant select on public.document_ingestion_jobs to authenticated;
grant all on public.course_documents to service_role;
grant all on public.document_ingestion_jobs to service_role;

create policy course_documents_select_for_members
  on public.course_documents for select to authenticated
  using (private.user_can_access_course(course_id));

create policy course_documents_insert_for_managers
  on public.course_documents for insert to authenticated
  with check (
    private.user_can_manage_course(course_id)
    and created_by = (select auth.uid())
  );

create policy document_ingestion_jobs_select_for_course_managers
  on public.document_ingestion_jobs for select to authenticated
  using (
    exists (
      select 1 from public.course_documents d
      where d.id = document_id
        and private.user_can_manage_course(d.course_id)
    )
  );

create or replace function private.enqueue_document_ingestion()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.document_ingestion_jobs (document_id)
  values (new.id);
  return new;
end;
$$;

revoke all on function private.enqueue_document_ingestion() from public;

drop trigger if exists course_documents_enqueue_ingestion
  on public.course_documents;
create trigger course_documents_enqueue_ingestion
  after insert on public.course_documents
  for each row execute function private.enqueue_document_ingestion();

create or replace function public.retry_document_ingestion(target_document_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_status text;
  new_job_id uuid;
begin
  select d.status into target_status
  from public.course_documents d
  where d.id = target_document_id
    and private.user_can_manage_course(d.course_id)
  for update;

  if not found then
    raise exception 'Document not found or access denied' using errcode = '42501';
  end if;
  if target_status <> 'failed' then
    raise exception 'Only failed documents can be retried' using errcode = '23514';
  end if;

  update public.course_documents
  set status = 'queued', updated_at = now()
  where id = target_document_id;

  insert into public.document_ingestion_jobs (document_id)
  values (target_document_id)
  returning id into new_job_id;

  return new_job_id;
end;
$$;

revoke all on function public.retry_document_ingestion(uuid) from public;
grant execute on function public.retry_document_ingestion(uuid) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'course-documents',
  'course-documents',
  false,
  26214400,
  array[
    'application/pdf',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists course_documents_storage_select
  on storage.objects;
create policy course_documents_storage_select
  on storage.objects for select to authenticated
  using (
    bucket_id = 'course-documents'
    and private.user_can_access_course_folder((storage.foldername(name))[1])
  );

drop policy if exists course_documents_storage_insert
  on storage.objects;
create policy course_documents_storage_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'course-documents'
    and private.user_can_manage_course_folder((storage.foldername(name))[1])
  );

drop policy if exists course_documents_storage_delete
  on storage.objects;
create policy course_documents_storage_delete
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'course-documents'
    and private.user_can_manage_course_folder((storage.foldername(name))[1])
  );

