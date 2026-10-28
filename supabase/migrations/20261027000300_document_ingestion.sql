create schema if not exists extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.course_documents (id) on delete cascade,
  course_id uuid not null references public.courses (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (length(content) between 1 and 8000),
  embedding extensions.vector not null,
  embedding_dimension integer not null check (
    embedding_dimension = extensions.vector_dims(embedding)
  ),
  embedding_model text not null check (length(embedding_model) between 1 and 200),
  page_start integer,
  page_end integer,
  unique (document_id, chunk_index),
  check (page_start is null or page_start > 0),
  check (page_end is null or page_end >= page_start)
);

alter table public.document_ingestion_jobs
  add column if not exists lease_token uuid;

create index if not exists document_chunks_course_document_idx
  on public.document_chunks (course_id, document_id, chunk_index);

alter table public.document_chunks enable row level security;
grant select on public.document_chunks to authenticated;
grant all on public.document_chunks to service_role;

create policy document_chunks_select_for_course_members
  on public.document_chunks for select to authenticated
  using (private.user_can_access_course(course_id));

create or replace function public.claim_document_ingestion_job()
returns table (
  job_id uuid,
  lease_token uuid,
  document_id uuid,
  attempt_count integer,
  max_attempts integer,
  title text,
  file_name text,
  mime_type text,
  storage_path text,
  size_bytes bigint,
  sha256 text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  with timed_out as (
    update public.document_ingestion_jobs j
    set status = 'failed',
        lease_token = null,
        completed_at = now(),
        updated_at = now(),
        last_error = coalesce(j.last_error, 'Worker lease expired after final attempt')
    where j.status = 'processing'
      and j.started_at < now() - interval '15 minutes'
      and j.attempt_count >= j.max_attempts
    returning j.document_id
  )
  update public.course_documents d
  set status = 'failed', updated_at = now()
  from timed_out t
  where d.id = t.document_id;

  return query
  with next_job as (
    select j.id
    from public.document_ingestion_jobs j
    where (
      j.status = 'queued' and j.next_attempt_at <= now()
    ) or (
      j.status = 'processing'
      and j.started_at < now() - interval '15 minutes'
      and j.attempt_count < j.max_attempts
    )
    order by j.next_attempt_at, j.created_at
    for update skip locked
    limit 1
  ), claimed as (
    update public.document_ingestion_jobs j
    set status = 'processing',
        attempt_count = j.attempt_count + 1,
        lease_token = gen_random_uuid(),
        started_at = now(),
        completed_at = null,
        updated_at = now()
    from next_job n
    where j.id = n.id
    returning j.id, j.lease_token, j.document_id, j.attempt_count, j.max_attempts
  ), mark_document as (
    update public.course_documents d
    set status = 'processing', updated_at = now()
    from claimed c
    where d.id = c.document_id
    returning d.id, d.title, d.file_name, d.mime_type, d.storage_path, d.size_bytes, d.sha256
  )
  select c.id, c.lease_token, c.document_id, c.attempt_count, c.max_attempts,
         d.title, d.file_name, d.mime_type, d.storage_path, d.size_bytes, d.sha256
  from claimed c
  join mark_document d on d.id = c.document_id;
end;
$$;

create or replace function public.complete_document_ingestion(
  target_job_id uuid,
  target_lease_token uuid,
  chunk_payloads jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document_id uuid;
  inserted_count integer;
begin
  select j.document_id into target_document_id
  from public.document_ingestion_jobs j
  where j.id = target_job_id
    and j.status = 'processing'
    and j.lease_token = target_lease_token
  for update;

  if not found then
    raise exception 'Ingestion job is not claimed' using errcode = '23514';
  end if;
  if jsonb_typeof(chunk_payloads) is distinct from 'array' then
    raise exception 'Invalid chunk payload' using errcode = '22023';
  end if;
  if jsonb_array_length(chunk_payloads) > 10000 then
    raise exception 'Too many document chunks' using errcode = '22023';
  end if;

  delete from public.document_chunks where document_id = target_document_id;

  insert into public.document_chunks (
    document_id, course_id, chunk_index, content, embedding,
    embedding_dimension, embedding_model, page_start, page_end
  )
  select target_document_id,
         d.course_id,
         p.chunk_index,
         p.content,
         p.embedding::extensions.vector,
         extensions.vector_dims(p.embedding::extensions.vector),
         p.embedding_model,
         p.page_start,
         p.page_end
  from jsonb_to_recordset(chunk_payloads) as p(
    chunk_index integer,
    content text,
    embedding text,
    embedding_model text,
    page_start integer,
    page_end integer
  )
  cross join public.course_documents d
  where d.id = target_document_id;

  get diagnostics inserted_count = row_count;
  if inserted_count = 0 then
    raise exception 'No document chunks were provided' using errcode = '22023';
  end if;

  update public.document_ingestion_jobs
  set status = 'succeeded', lease_token = null,
      completed_at = now(), updated_at = now(), last_error = null
  where id = target_job_id;

  update public.course_documents
  set status = 'ready', updated_at = now()
  where id = target_document_id;
end;
$$;

create or replace function public.fail_document_ingestion(
  target_job_id uuid,
  target_lease_token uuid,
  error_message text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document_id uuid;
  attempt integer;
  limit_attempts integer;
  next_status text;
begin
  select j.document_id, j.attempt_count, j.max_attempts
    into target_document_id, attempt, limit_attempts
  from public.document_ingestion_jobs j
  where j.id = target_job_id
    and j.status = 'processing'
    and j.lease_token = target_lease_token
  for update;

  if not found then
    raise exception 'Ingestion job is not claimed' using errcode = '23514';
  end if;

  next_status := case when attempt >= limit_attempts then 'failed' else 'queued' end;
  update public.document_ingestion_jobs
  set status = next_status,
      lease_token = null,
      next_attempt_at = now() + make_interval(secs => least(300, 5 * power(2, least(attempt - 1, 6))::integer)),
      completed_at = case when next_status = 'failed' then now() else null end,
      updated_at = now(),
      last_error = left(coalesce(error_message, 'Unknown ingestion failure'), 2000)
  where id = target_job_id;

  update public.course_documents
  set status = next_status, updated_at = now()
  where id = target_document_id;

  return next_status;
end;
$$;

create or replace function public.renew_document_ingestion_job(
  target_job_id uuid,
  target_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_ingestion_jobs
  set started_at = now(), updated_at = now()
  where id = target_job_id
    and status = 'processing'
    and lease_token = target_lease_token;
  return found;
end;
$$;

revoke all on function public.claim_document_ingestion_job() from public;
revoke all on function public.complete_document_ingestion(uuid, uuid, jsonb) from public;
revoke all on function public.fail_document_ingestion(uuid, uuid, text) from public;
revoke all on function public.renew_document_ingestion_job(uuid, uuid) from public;
grant execute on function public.claim_document_ingestion_job() to service_role;
grant execute on function public.complete_document_ingestion(uuid, uuid, jsonb) to service_role;
grant execute on function public.fail_document_ingestion(uuid, uuid, text) to service_role;
grant execute on function public.renew_document_ingestion_job(uuid, uuid) to service_role;
