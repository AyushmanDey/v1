-- Course managers can delete a course document. Deleting the row cascades to its
-- chunks (embeddings) and ingestion jobs in the same transaction, so the content
-- stops being retrievable immediately. The function returns the storage path so the
-- API can remove the stored file afterwards (the storage delete policy already
-- allows course managers to do that with their own token).
create or replace function public.delete_course_document(
  target_course_id uuid,
  target_document_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_path text;
begin
  -- Non-members learn nothing: a document they cannot see reads as "not found".
  if not private.user_can_access_course(target_course_id) then
    return null;
  end if;

  select d.storage_path into target_path
  from public.course_documents d
  where d.id = target_document_id
    and d.course_id = target_course_id
  for update;

  if not found then
    return null;
  end if;

  if not private.user_can_manage_course(target_course_id) then
    raise exception 'Only course managers can delete course documents'
      using errcode = '42501';
  end if;

  delete from public.course_documents
  where id = target_document_id;

  return target_path;
end;
$$;

revoke all on function public.delete_course_document(uuid, uuid) from public;
grant execute on function public.delete_course_document(uuid, uuid) to authenticated;
