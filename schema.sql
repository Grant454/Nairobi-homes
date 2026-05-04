-- ═══════════════════════════════════════════════════════════════════
--  NairobiHomes — Supabase SQL Schema  (Run once in SQL Editor)
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. PROFILES ──────────────────────────────────────────────────
create table if not exists public.profiles (
  id         uuid        primary key references auth.users(id) on delete cascade,
  name       text        not null,
  email      text        not null unique,
  role       text        not null default 'user' check (role in ('admin','user')),
  created_at timestamptz not null default now()
);

-- Auto-create profile on every new signup via trigger
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)),
    new.email,
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ── 2. PROPERTIES ────────────────────────────────────────────────
create table if not exists public.properties (
  id          uuid          default gen_random_uuid() primary key,
  title       text          not null,
  price       numeric(12,2) not null check (price > 0),
  location    text          not null,
  rooms       int           not null check (rooms between 1 and 20),
  description text          not null,
  water       boolean       not null default false,
  security    boolean       not null default false,
  status      text          not null default 'active' check (status in ('active','inactive')),
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

drop trigger if exists trg_properties_updated_at on public.properties;
create trigger trg_properties_updated_at
  before update on public.properties
  for each row execute procedure public.set_updated_at();

-- ── 3. PROPERTY IMAGES ───────────────────────────────────────────
create table if not exists public.property_images (
  id          uuid        default gen_random_uuid() primary key,
  property_id uuid        not null references public.properties(id) on delete cascade,
  image_path  text        not null,
  is_primary  boolean     not null default false,
  uploaded_at timestamptz not null default now()
);

-- ── 4. FAVORITES ─────────────────────────────────────────────────
create table if not exists public.favorites (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  property_id uuid        not null references public.properties(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique(user_id, property_id)
);

-- ── 5. REVIEWS ───────────────────────────────────────────────────
create table if not exists public.reviews (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  property_id uuid        not null references public.properties(id) on delete cascade,
  rating      int         not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now(),
  unique(user_id, property_id)
);

-- ── 6. REPORTS ───────────────────────────────────────────────────
create table if not exists public.reports (
  id          uuid        default gen_random_uuid() primary key,
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  property_id uuid        not null references public.properties(id) on delete cascade,
  reason      text        not null,
  created_at  timestamptz not null default now()
);

-- ═══════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════

alter table public.profiles        enable row level security;
alter table public.properties      enable row level security;
alter table public.property_images enable row level security;
alter table public.favorites       enable row level security;
alter table public.reviews         enable row level security;
alter table public.reports         enable row level security;

-- Shared admin helper
create or replace function public.is_admin()
returns boolean language sql security definer stable as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- PROFILES
drop policy if exists "profiles_select" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_admin"  on public.profiles;
create policy "profiles_select" on public.profiles for select using (true);
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = id);
create policy "profiles_admin"  on public.profiles for all using (public.is_admin());

-- PROPERTIES
drop policy if exists "props_select" on public.properties;
drop policy if exists "props_admin"  on public.properties;
create policy "props_select" on public.properties for select
  using (status = 'active' or public.is_admin());
create policy "props_admin" on public.properties for all using (public.is_admin());

-- PROPERTY IMAGES
drop policy if exists "imgs_select" on public.property_images;
drop policy if exists "imgs_admin"  on public.property_images;
create policy "imgs_select" on public.property_images for select using (true);
create policy "imgs_admin"  on public.property_images for all using (public.is_admin());

-- FAVORITES
drop policy if exists "favs_select" on public.favorites;
drop policy if exists "favs_insert" on public.favorites;
drop policy if exists "favs_delete" on public.favorites;
create policy "favs_select" on public.favorites for select using (auth.uid() = user_id);
create policy "favs_insert" on public.favorites for insert with check (auth.uid() = user_id);
create policy "favs_delete" on public.favorites for delete using (auth.uid() = user_id);

-- REVIEWS
drop policy if exists "revs_select" on public.reviews;
drop policy if exists "revs_insert" on public.reviews;
drop policy if exists "revs_update" on public.reviews;
drop policy if exists "revs_admin"  on public.reviews;
create policy "revs_select" on public.reviews for select using (true);
create policy "revs_insert" on public.reviews for insert with check (auth.uid() = user_id);
create policy "revs_update" on public.reviews for update using (auth.uid() = user_id);
create policy "revs_admin"  on public.reviews for all using (public.is_admin());

-- REPORTS
drop policy if exists "rpts_insert" on public.reports;
drop policy if exists "rpts_select" on public.reports;
drop policy if exists "rpts_delete" on public.reports;
create policy "rpts_insert" on public.reports for insert with check (auth.uid() = user_id);
create policy "rpts_select" on public.reports for select using (public.is_admin());
create policy "rpts_delete" on public.reports for delete using (public.is_admin());

-- ═══════════════════════════════════════════════════════════════════
--  STORAGE BUCKET
-- ═══════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('properties','properties',true,5242880,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

drop policy if exists "storage_select" on storage.objects;
drop policy if exists "storage_insert" on storage.objects;
drop policy if exists "storage_update" on storage.objects;
drop policy if exists "storage_delete" on storage.objects;
create policy "storage_select" on storage.objects for select using (bucket_id = 'properties');
create policy "storage_insert" on storage.objects for insert
  with check (bucket_id = 'properties' and public.is_admin());
create policy "storage_update" on storage.objects for update
  using (bucket_id = 'properties' and public.is_admin());
create policy "storage_delete" on storage.objects for delete
  using (bucket_id = 'properties' and public.is_admin());

-- ═══════════════════════════════════════════════════════════════════
--  SAMPLE DATA
-- ═══════════════════════════════════════════════════════════════════

insert into public.properties (title,price,location,rooms,description,water,security,status) values
('Modern 3BR Apartment in Kilimani', 45000,'Kilimani',3,
 'Spacious modern apartment in the heart of Kilimani. Large living area, fitted kitchen, stunning city views. Walking distance to Yaya Centre. Secure parking included.',
 true,true,'active'),
('Cozy Studio — Westlands', 18000,'Westlands',1,
 'Well-furnished studio perfect for young professionals. Close to major roads and matatus. Fitted kitchenette, en-suite bathroom, high-speed fibre internet ready.',
 true,true,'active'),
('Executive Family Home — Karen', 120000,'Karen',5,
 'Elegant home on a quiet cul-de-sac in Karen. Large garden, SQ, 3 full bathrooms, double garage. Minutes from Karen Hub and top schools. Extremely peaceful.',
 true,true,'active'),
('Affordable 1BR — Ngong Road', 22000,'Ngong Road',1,
 'Clean 1-bedroom flat near Ngong Road. Tiled floors, balcony, 24hr water. Close to Prestige Plaza. Ideal for singles or young couples. Very accessible.',
 true,false,'active'),
('Luxury Penthouse — Upper Hill', 180000,'Upper Hill',4,
 'Spectacular penthouse with panoramic Nairobi skyline views. Private rooftop terrace, premium finishes, concierge service, 2 underground parking bays.',
 true,true,'active'),
('Modern 2BR — Ruaka', 28000,'Ruaka',2,
 'Contemporary 2-bedroom apartment in fast-growing Ruaka. Walking distance to Quickmart and Ruaka Mall. Gated compound with 24hr security and full CCTV.',
 true,true,'active'),
('Studio Apartment — Lavington', 20000,'Lavington',1,
 'Elegant studio in the quiet leafy suburb of Lavington. Very secure, close to Valley Arcade and good restaurants. Perfect for professionals.',
 true,true,'active'),
('3BR Townhouse — Kileleshwa', 65000,'Kileleshwa',3,
 'Beautiful townhouse in prime Kileleshwa. 3 spacious bedrooms, fitted kitchen, private garden. Gated estate, backup generator, borehole water.',
 true,true,'active'),
('Budget Studio — Kasarani', 12000,'Kasarani',1,
 'Affordable studio near Kasarani Stadium and Thika Road mall. Clean, well-maintained. Ideal for students and young workers. Easy public transport access.',
 true,false,'active');

-- ═══════════════════════════════════════════════════════════════════
--  AFTER REGISTERING — run this to make yourself admin:
--  UPDATE public.profiles SET role = 'admin' WHERE email = 'your@email.com';
-- ═══════════════════════════════════════════════════════════════════
