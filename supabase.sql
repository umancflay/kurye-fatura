-- Kurye Fatura Paneli — Supabase kurulumu
-- Supabase → SQL Editor → bu dosyanın tamamını yapıştır → Run.
-- Sonra en alttaki e-postayı kendi giriş e-postanla değiştirip tekrar çalıştır.

-- Panele girebilecek kişiler (e-posta listesi)
create table if not exists public.kurye_members (
  email text primary key
);

-- Tüm panel verisi tek satırda tutulur (kişiler, fiyatlar, aylık kayıtlar, ayarlar)
create table if not exists public.kurye_store (
  id text primary key default 'main',
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.kurye_members enable row level security;
alter table public.kurye_store enable row level security;

create or replace function public.kurye_is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.kurye_members m
    where lower(m.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

drop policy if exists "kurye uye kendini gorur" on public.kurye_members;
create policy "kurye uye kendini gorur" on public.kurye_members
  for select to authenticated using (public.kurye_is_member());

drop policy if exists "kurye uye okur" on public.kurye_store;
create policy "kurye uye okur" on public.kurye_store
  for select to authenticated using (public.kurye_is_member());

drop policy if exists "kurye uye ekler" on public.kurye_store;
create policy "kurye uye ekler" on public.kurye_store
  for insert to authenticated with check (public.kurye_is_member());

drop policy if exists "kurye uye gunceller" on public.kurye_store;
create policy "kurye uye gunceller" on public.kurye_store
  for update to authenticated using (public.kurye_is_member()) with check (public.kurye_is_member());

-- Giriş yapabilecek e-postalar (Authentication → Users'ta da bu e-postayla kullanıcı oluştur)
insert into public.kurye_members (email) values ('SENIN@EPOSTAN.com')
on conflict do nothing;
