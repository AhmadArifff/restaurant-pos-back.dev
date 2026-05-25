-- Supabase/PostgreSQL schema for Restaurant POS
-- Run this file in Supabase SQL Editor before migrating data.

create extension if not exists pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'kasir');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM ('cash', 'qris', 'transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_movement_type AS ENUM ('IN', 'OUT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE main_stock_type AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE main_stock_source AS ENUM ('purchase', 'request', 'adjustment', 'transaction');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE stock_request_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

create table if not exists users (
  id bigserial primary key,
  name varchar(100) not null,
  email varchar(100) unique not null,
  password varchar(255) not null,
  role user_role default 'kasir',
  created_at timestamptz default now()
);

create table if not exists categories (
  id bigserial primary key,
  name varchar(100) not null
);

create table if not exists products (
  id bigserial primary key,
  name varchar(150) not null,
  price numeric(10,2) not null,
  category_id bigint references categories(id) on delete set null,
  image_url text null,
  created_at timestamptz default now()
);

create table if not exists transactions (
  id bigserial primary key,
  invoice_number varchar(50) unique not null,
  total_price numeric(10,2) not null,
  payment_method payment_method default 'cash',
  created_by bigint not null references users(id),
  source_user_id bigint null references users(id),
  created_at timestamptz default now()
);

create table if not exists transaction_items (
  id bigserial primary key,
  transaction_id bigint not null references transactions(id) on delete cascade,
  product_id bigint not null references products(id),
  price numeric(10,2) not null,
  qty integer not null,
  subtotal numeric(10,2) not null
);

create table if not exists stock_movements (
  id bigserial primary key,
  product_id bigint not null references products(id),
  type stock_movement_type not null,
  qty integer not null,
  reference varchar(100),
  created_at timestamptz default now()
);

create table if not exists stock_items (
  id bigserial primary key,
  name varchar(150) not null,
  unit varchar(20) not null default 'pcs',
  stock numeric(10,2) not null default 0,
  total_price numeric(12,2) not null default 0,
  price_per_unit numeric(12,2) not null default 0,
  min_stock numeric(10,2) not null default 5,
  created_at timestamptz default now()
);

create table if not exists product_ingredients (
  id bigserial primary key,
  product_id bigint not null references products(id) on delete cascade,
  stock_item_id bigint not null references stock_items(id) on delete cascade,
  qty numeric(10,4) not null default 1,
  constraint unique_ingredient unique (product_id, stock_item_id)
);

create table if not exists stock_item_movements (
  id bigserial primary key,
  stock_item_id bigint not null references stock_items(id),
  type stock_movement_type not null,
  qty integer not null,
  reference varchar(100),
  created_at timestamptz default now()
);

create table if not exists attendance (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  login_at timestamptz default now(),
  logout_at timestamptz null,
  date date not null
);

create table if not exists main_stock (
  id bigserial primary key,
  stock_item_id bigint not null references stock_items(id) on delete cascade,
  qty numeric(10,2) not null default 0,
  cost_per_unit numeric(15,2) not null default 0,
  total_cost numeric(15,2) generated always as (qty * cost_per_unit) stored,
  type main_stock_type not null,
  source main_stock_source not null default 'purchase',
  reference_id bigint null,
  note text null,
  created_by bigint not null references users(id),
  created_at timestamptz default now()
);

create table if not exists stock_requests (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  date date not null,
  status stock_request_status not null default 'pending',
  note text null,
  created_by_admin bigint null references users(id),
  approved_by bigint null references users(id),
  approved_at timestamptz null,
  approval_notes text null,
  created_at timestamptz default now()
);

create table if not exists stock_request_items (
  id bigserial primary key,
  request_id bigint not null references stock_requests(id) on delete cascade,
  stock_item_id bigint not null references stock_items(id) on delete cascade,
  qty_requested numeric(10,2) not null,
  qty_approved numeric(10,2) null,
  cost_per_unit numeric(15,2) not null default 0,
  created_at timestamptz default now()
);

create table if not exists website_settings (
  id bigserial primary key,
  setting_key varchar(100) unique not null,
  setting_value text not null,
  data_type varchar(20) not null default 'string' check (data_type in ('string','number','boolean','json')),
  updated_by bigint null references users(id) on delete set null,
  updated_at timestamptz default now()
);

create table if not exists stock_request_audit (
  id bigserial primary key,
  request_id bigint not null references stock_requests(id) on delete cascade,
  action varchar(50) not null,
  approved_qty numeric(10,2) null,
  approved_by bigint not null references users(id) on delete restrict,
  note text null,
  created_at timestamptz default now()
);

create index if not exists idx_attendance_date on attendance(date);
create index if not exists idx_attendance_user_date on attendance(user_id, date);
create index if not exists idx_main_stock_type on main_stock(type);
create index if not exists idx_main_stock_source on main_stock(source);
create index if not exists idx_main_stock_created_at on main_stock(created_at);
create index if not exists idx_main_stock_item on main_stock(stock_item_id);
create index if not exists idx_stock_requests_status on stock_requests(status);
create index if not exists idx_stock_requests_date on stock_requests(date);
create index if not exists idx_website_settings_setting_key on website_settings(setting_key);
create index if not exists idx_stock_request_audit_request_id on stock_request_audit(request_id);
create index if not exists idx_stock_request_audit_action on stock_request_audit(action);
create index if not exists idx_stock_request_audit_created_at on stock_request_audit(created_at);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_website_settings_updated_at on website_settings;
create trigger set_website_settings_updated_at
before update on website_settings
for each row execute function set_updated_at();
