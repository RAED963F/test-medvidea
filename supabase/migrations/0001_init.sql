-- ════════════════════════════════════════════════════════════════════════
--  MediVia — patient intake MVP · database schema, RLS, storage, admin
--  Run this once against your Supabase project (SQL editor or `supabase db push`).
-- ════════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ─────────────────────────────────────────────────────────────
--  Reference number sequence  →  MV-<year>-<0000>
--  A global counter (does not reset per year). 4-digit zero-padded,
--  grows past 9999 automatically. Uniqueness is guaranteed by the
--  sequence + the UNIQUE constraint on cases.reference.
-- ─────────────────────────────────────────────────────────────
create sequence if not exists public.case_ref_seq start with 1000 increment by 1;

-- ─────────────────────────────────────────────────────────────
--  Admin allowlist. A Supabase Auth user only becomes an admin when
--  their id is present here. Enrolment is a manual, privileged action.
-- ─────────────────────────────────────────────────────────────
create table if not exists public.admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;
-- No policies on purpose: the table is only ever read through the
-- SECURITY DEFINER helper below, never directly by client keys.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins a where a.user_id = auth.uid()
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- ─────────────────────────────────────────────────────────────
--  Cases (patient intake)
-- ─────────────────────────────────────────────────────────────
create table if not exists public.cases (
  id              uuid primary key default gen_random_uuid(),
  reference       text unique not null,
  status          text not null default 'new'
                    check (status in ('new','reviewing','contacted','in_progress','completed','rejected')),

  first_name      text not null,
  last_name       text not null,
  nationality     text not null,
  age             integer not null check (age >= 0 and age <= 120),
  sex             text not null check (sex in ('male','female')),
  whatsapp        text,
  email           text,
  reason          text not null,
  details         text not null,

  -- File metadata. Actual bytes live in the private `case-files` bucket.
  --   images: [ { path, name, size, type }, ... ]  (0–5)
  --   report: { path, name, size } | null           (0–1 PDF)
  images          jsonb not null default '[]'::jsonb,
  report          jsonb,

  consent         boolean not null default false,
  source          text default 'website',
  idempotency_key uuid unique,          -- dedupes double submits / retries
  ip_hash         text,                 -- sha-256(ip) — abuse triage only
  user_agent      text,
  submitted_at    timestamptz,          -- client-declared timestamp

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists cases_created_idx on public.cases (created_at desc);
create index if not exists cases_status_idx  on public.cases (status);

-- Assign the reference on insert if the caller did not supply one.
create or replace function public.set_case_reference()
returns trigger
language plpgsql
as $$
begin
  if new.reference is null or new.reference = '' then
    new.reference :=
      'MV-' || to_char(now(), 'YYYY') || '-' ||
      lpad(nextval('public.case_ref_seq')::text, 4, '0');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_case_reference on public.cases;
create trigger trg_set_case_reference
  before insert on public.cases
  for each row execute function public.set_case_reference();

-- Keep updated_at fresh.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_cases on public.cases;
create trigger trg_touch_cases
  before update on public.cases
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────
--  Row Level Security on cases
--  · Public / anon keys get NOTHING (no select, insert, update, delete).
--  · Inserts are performed by the Edge Function using the service-role
--    key, which bypasses RLS entirely.
--  · Signed-in admins can read every case and update it (status changes).
-- ─────────────────────────────────────────────────────────────
alter table public.cases enable row level security;

drop policy if exists "admins read cases"   on public.cases;
drop policy if exists "admins update cases" on public.cases;

create policy "admins read cases"
  on public.cases for select
  to authenticated
  using (public.is_admin());

create policy "admins update cases"
  on public.cases for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- ─────────────────────────────────────────────────────────────
--  Private storage bucket for medical files
-- ─────────────────────────────────────────────────────────────


-- Uploads are done by the Edge Function (service role) → no write policy
-- needed. Admins need SELECT so they can mint signed URLs from the browser.
drop policy if exists "admins read case files" on storage.objects;
create policy "admins read case files"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'case-files' and public.is_admin());

-- ════════════════════════════════════════════════════════════════════════
--  AFTER creating your admin auth user (Dashboard → Authentication → Users,
--  or `supabase auth`), enrol them by running ONE of the following:
--
--    insert into public.admins (user_id, email)
--    values ('<AUTH-USER-UUID>', 'admin@medical-via.com');
--
--  or, by email, once the user exists in auth.users:
--
--    insert into public.admins (user_id, email)
--    select id, email from auth.users where email = 'admin@medical-via.com'
--    on conflict (user_id) do nothing;
-- ════════════════════════════════════════════════════════════════════════
