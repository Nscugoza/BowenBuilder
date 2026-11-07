-- Finished per-lot marketing flyer PDFs.
-- Do not reapply 20261107220011. That SQL is already on production under
-- migration history version 20261107223821. Reconcile those versions before
-- any future supabase db push.
-- This file does not change appointment_time or existing storage policies.
-- Objects stay in the private lot-documents bucket. The first path folder is
-- the lot id, which the existing lot-documents policies already require.

create table if not exists public.lot_marketing_flyers (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references public.lots(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null,
  mime_type text not null default 'application/pdf',
  size_bytes bigint,
  created_by uuid,
  created_at timestamptz not null default now(),
  constraint lot_marketing_flyers_pdf_name check (file_name ~* '\.pdf$'),
  constraint lot_marketing_flyers_pdf_type check (mime_type = 'application/pdf'),
  constraint lot_marketing_flyers_path_matches_lot check (
    storage_path = lot_id::text || '/marketing-flyer/' || id::text || '.pdf'
  )
);

comment on table public.lot_marketing_flyers is
  'Finished marketing flyer PDFs uploaded for one lot. Private; opened with signed URLs.';

create index if not exists lot_marketing_flyers_lot_created_idx
  on public.lot_marketing_flyers (lot_id, created_at desc);

alter table public.lot_marketing_flyers enable row level security;

revoke all on public.lot_marketing_flyers from public, anon;
grant select, insert on public.lot_marketing_flyers to authenticated;

create policy lot_marketing_flyers_select
  on public.lot_marketing_flyers
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.lots l
      where l.id = lot_marketing_flyers.lot_id
        and (
          exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid())
              and p.role::text = 'admin'
          )
          or exists (
            select 1 from public.subdivision_members sm
            where sm.subdivision_id = l.subdivision_id
              and sm.user_id = (select auth.uid())
          )
        )
    )
  );

create policy lot_marketing_flyers_insert
  on public.lot_marketing_flyers
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.lots l
      where l.id = lot_marketing_flyers.lot_id
        and (
          exists (
            select 1 from public.profiles p
            where p.id = (select auth.uid())
              and p.role::text = 'admin'
          )
          or exists (
            select 1 from public.subdivision_members sm
            where sm.subdivision_id = l.subdivision_id
              and sm.user_id = (select auth.uid())
          )
        )
    )
  );

notify pgrst, 'reload schema';
