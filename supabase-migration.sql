-- 1. Create Profiles Table
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  enrollment_no text,
  full_name text not null,
  created_at timestamptz default now() not null
);

-- 2. Create Accsoft Connections Table (stores separate password hash, iv, tag, and sync details)
create table public.accsoft_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null unique,
  enrollment_no text not null,
  encrypted_password text not null,
  iv text not null,
  auth_tag text not null,
  last_sync_at timestamptz,
  last_sync_status text,
  last_sync_message text,
  created_at timestamptz default now() not null
);

-- 3. Create Attendance Summary Table
create table public.attendance_summary (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  subject_name text not null,
  held integer not null,
  present integer not null,
  absent integer not null,
  percentage numeric(5,2) not null,
  synced_at timestamptz default now() not null,
  unique (user_id, subject_name)
);

-- 4. Create Attendance Logs Table (for unique constraints on date, period, subject, and user)
create table public.attendance_logs (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users on delete cascade not null,
  attendance_date date not null,
  period_no integer not null,
  subject_name text not null,
  status text not null,
  synced_at timestamptz default now() not null,
  unique (user_id, attendance_date, period_no, subject_name)
);

-- 5. Enable Row Level Security (RLS)
alter table public.profiles enable row level security;
alter table public.accsoft_connections enable row level security;
alter table public.attendance_summary enable row level security;
alter table public.attendance_logs enable row level security;

-- 6. Setup RLS Policies (Users can only see and write their own data)
create policy "Users can view own profile" on public.profiles
  for select using (auth.uid() = id);

create policy "Users can update own profile" on public.profiles
  for update using (auth.uid() = id);

create policy "Users can insert own profile" on public.profiles
  for insert with check (auth.uid() = id);

create policy "Users can manage own connection" on public.accsoft_connections
  for all using (auth.uid() = user_id);

create policy "Users can manage own attendance summary" on public.attendance_summary
  for all using (auth.uid() = user_id);

create policy "Users can manage own attendance logs" on public.attendance_logs
  for all using (auth.uid() = user_id);

-- 7. Trigger to automatically create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, full_name, enrollment_no)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    coalesce(new.raw_user_meta_data->>'enrollment_no', '')
  );
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 8. Trigger function to automatically update profiles.enrollment_no when accsoft_connections is upserted
create or replace function public.sync_enrollment_to_profile()
returns trigger as $$
begin
  update public.profiles
  set enrollment_no = new.enrollment_no
  where id = new.user_id
    and (enrollment_no is null or enrollment_no = '');
  return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_connection_upserted
  after insert or update of enrollment_no on public.accsoft_connections
  for each row execute procedure public.sync_enrollment_to_profile();

-- 9. Backfill existing users who have connections but empty profile enrollment numbers
update public.profiles p
set enrollment_no = c.enrollment_no
from public.accsoft_connections c
where p.id = c.user_id
  and (p.enrollment_no is null or p.enrollment_no = '');

