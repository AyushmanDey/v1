create or replace function public.current_user_can_access_course(target_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.courses c
    where c.id = target_course_id
      and (
        c.owner_id = (select auth.uid())
        or exists (
          select 1
          from public.course_memberships cm
          where cm.course_id = c.id
            and cm.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.current_user_can_access_course(uuid) from public;
grant execute on function public.current_user_can_access_course(uuid) to authenticated;

create or replace function public.match_course_document_chunks(
  query_embedding text,
  target_course_id uuid,
  target_embedding_model text,
  minimum_similarity real,
  maximum_results integer
)
returns table (
  chunk_id uuid,
  document_id uuid,
  chunk_index integer,
  title text,
  file_name text,
  storage_path text,
  content text,
  page_start integer,
  page_end integer,
  similarity real
)
language sql
stable
set search_path = ''
as $$
  with query_vector as (
    select query_embedding::extensions.vector as value
  ), scored as (
    select dc.id as chunk_id,
           dc.document_id,
           dc.chunk_index,
           d.title,
           d.file_name,
           d.storage_path,
           dc.content,
           dc.page_start,
           dc.page_end,
           case
             when dc.embedding_dimension = extensions.vector_dims(q.value)
               then (1 - (dc.embedding OPERATOR(extensions.<=>) q.value))::real
             else null
           end as similarity
    from public.document_chunks dc
    join public.course_documents d on d.id = dc.document_id
    cross join query_vector q
    where dc.course_id = target_course_id
      and dc.embedding_model = target_embedding_model
      and dc.embedding_dimension = extensions.vector_dims(q.value)
      and d.status = 'ready'
  )
  select s.chunk_id,
         s.document_id,
         s.chunk_index,
         s.title,
         s.file_name,
         s.storage_path,
         s.content,
         s.page_start,
         s.page_end,
         s.similarity
  from scored s
  where s.similarity >= greatest(-1, least(minimum_similarity, 1))
  order by s.similarity desc
  limit greatest(1, least(maximum_results, 10));
$$;

revoke all on function public.match_course_document_chunks(text, uuid, text, real, integer)
  from public;
grant execute on function public.match_course_document_chunks(text, uuid, text, real, integer)
  to authenticated;
