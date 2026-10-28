-- Minimal course boundary for the pilot. Course content and documents are added
-- in later migrations with their own ownership and storage policies.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 200),
  code text not null check (length(trim(code)) between 1 and 40),
  created_at timestamptz not null default now()
);

create table if not exists public.course_memberships (
  course_id uuid not null references public.courses (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('student', 'instructor', 'admin')),
  created_at timestamptz not null default now(),
  primary key (course_id, user_id)
);

create index if not exists course_memberships_user_id_idx
  on public.course_memberships (user_id, course_id);

create or replace function private.user_can_access_course(target_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.courses c
    where c.id = target_course_id and c.owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.course_memberships cm
    where cm.course_id = target_course_id and cm.user_id = (select auth.uid())
  );
$$;

create or replace function private.user_can_manage_course(target_course_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.courses c
    where c.id = target_course_id and c.owner_id = (select auth.uid())
  ) or exists (
    select 1 from public.course_memberships cm
    where cm.course_id = target_course_id
      and cm.user_id = (select auth.uid())
      and cm.role = 'admin'
  );
$$;

revoke all on function private.user_can_access_course(uuid) from public;
revoke all on function private.user_can_manage_course(uuid) from public;
grant execute on function private.user_can_access_course(uuid) to authenticated;
grant execute on function private.user_can_manage_course(uuid) to authenticated;

alter table public.courses enable row level security;
alter table public.course_memberships enable row level security;

grant select, insert, update, delete on public.courses to authenticated;
grant select, insert, update, delete on public.course_memberships to authenticated;

create policy courses_select_for_members
  on public.courses for select to authenticated
  using (private.user_can_access_course(id));

create policy courses_insert_for_owner
  on public.courses for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy courses_update_for_owner
  on public.courses for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy courses_delete_for_owner
  on public.courses for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy course_memberships_select_for_member_or_manager
  on public.course_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.user_can_manage_course(course_id)
  );

create policy course_memberships_insert_for_manager
  on public.course_memberships for insert to authenticated
  with check (private.user_can_manage_course(course_id));

create policy course_memberships_update_for_manager
  on public.course_memberships for update to authenticated
  using (private.user_can_manage_course(course_id))
  with check (private.user_can_manage_course(course_id));

create policy course_memberships_delete_for_manager
  on public.course_memberships for delete to authenticated
  using (private.user_can_manage_course(course_id));
