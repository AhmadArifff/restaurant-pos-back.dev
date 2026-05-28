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

DO $$ BEGIN
  CREATE TYPE dining_table_status AS ENUM ('active', 'maintenance', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE customer_order_status AS ENUM ('pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE customer_payment_status AS ENUM ('unpaid', 'paid');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE branch_status AS ENUM ('active', 'inactive');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_program_type AS ENUM ('review_reward', 'voucher', 'bundle');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE discount_value_type AS ENUM ('percent', 'fixed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

create table if not exists branches (
  id bigserial primary key,
  branch_key varchar(100) unique not null,
  name varchar(150) not null,
  area varchar(150) null,
  address text null,
  phone varchar(60) null,
  status branch_status not null default 'active',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

insert into branches (branch_key, name, area, status)
values ('default', 'Cabang Utama', 'Default', 'active')
on conflict (branch_key) do nothing;

create table if not exists users (
  id bigserial primary key,
  name varchar(100) not null,
  email varchar(100) unique not null,
  password varchar(255) not null,
  role user_role default 'kasir',
  default_branch_id bigint null references branches(id) on delete set null,
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
  branch_id bigint null references branches(id) on delete set null,
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
  branch_id bigint null references branches(id) on delete set null,
  created_by bigint not null references users(id),
  created_at timestamptz default now()
);

create table if not exists stock_requests (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  date date not null,
  status stock_request_status not null default 'pending',
  note text null,
  branch_id bigint null references branches(id) on delete set null,
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

create table if not exists dining_tables (
  id bigserial primary key,
  table_number varchar(30) not null,
  table_name varchar(100) null,
  capacity integer not null default 2,
  qr_token varchar(80) unique not null,
  status dining_table_status not null default 'active',
  branch_id bigint null references branches(id) on delete set null,
  note text null,
  created_by bigint null references users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists customer_orders (
  id bigserial primary key,
  order_code varchar(50) unique not null,
  table_id bigint not null references dining_tables(id),
  branch_id bigint null references branches(id) on delete set null,
  customer_name varchar(120) null,
  customer_phone varchar(40) null,
  subtotal numeric(12,2) not null default 0,
  discount_rate numeric(5,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  final_total numeric(12,2) not null default 0,
  status customer_order_status not null default 'pending',
  payment_status customer_payment_status not null default 'unpaid',
  transaction_id bigint null references transactions(id) on delete set null,
  note text null,
  reviewed_at timestamptz null,
  accepted_by bigint null references users(id) on delete set null,
  accepted_at timestamptz null,
  completed_by bigint null references users(id) on delete set null,
  completed_at timestamptz null,
  cancel_reason text null,
  cancelled_by bigint null references users(id) on delete set null,
  cancelled_at timestamptz null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists customer_order_items (
  id bigserial primary key,
  order_id bigint not null references customer_orders(id) on delete cascade,
  product_id bigint not null references products(id),
  product_name varchar(150) not null,
  price numeric(10,2) not null,
  qty integer not null,
  subtotal numeric(12,2) not null,
  note text null
);

create table if not exists customer_order_reviews (
  id bigserial primary key,
  order_id bigint not null unique references customer_orders(id) on delete cascade,
  service_rating integer not null check (service_rating between 1 and 5),
  service_comment text null,
  created_at timestamptz default now()
);

create table if not exists customer_order_item_reviews (
  id bigserial primary key,
  order_id bigint not null references customer_orders(id) on delete cascade,
  order_item_id bigint not null unique references customer_order_items(id) on delete cascade,
  product_id bigint not null references products(id),
  rating integer not null check (rating between 1 and 5),
  comment text null,
  created_at timestamptz default now()
);

create table if not exists discount_programs (
  id bigserial primary key,
  name varchar(160) not null,
  type discount_program_type not null default 'voucher',
  code varchar(80) unique null,
  discount_type discount_value_type not null default 'percent',
  discount_value numeric(12,2) not null default 0,
  min_order_amount numeric(12,2) not null default 0,
  usage_limit_per_phone integer not null default 1,
  total_usage_limit integer null,
  min_service_rating integer not null default 1,
  min_menu_rating integer not null default 1,
  bundle_product_ids text null,
  status branch_status not null default 'active',
  note text null,
  created_by bigint null references users(id) on delete set null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists discount_redemptions (
  id bigserial primary key,
  program_id bigint not null references discount_programs(id) on delete cascade,
  order_id bigint null references customer_orders(id) on delete set null,
  transaction_id bigint null references transactions(id) on delete set null,
  customer_phone varchar(40) null,
  normalized_phone varchar(40) null,
  voucher_code varchar(80) null,
  subtotal numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  created_by bigint null references users(id) on delete set null,
  created_at timestamptz default now()
);

alter table users add column if not exists default_branch_id bigint null references branches(id) on delete set null;
alter table dining_tables add column if not exists branch_id bigint null references branches(id) on delete set null;
alter table customer_orders add column if not exists branch_id bigint null references branches(id) on delete set null;
alter table customer_orders add column if not exists cancel_reason text null;
alter table customer_orders add column if not exists cancelled_by bigint null references users(id) on delete set null;
alter table customer_orders add column if not exists cancelled_at timestamptz null;
alter table customer_orders add column if not exists discount_label varchar(160) null;
alter table customer_orders add column if not exists discount_program_id bigint null references discount_programs(id) on delete set null;
alter table customer_orders add column if not exists voucher_code varchar(80) null;
alter table transactions add column if not exists branch_id bigint null references branches(id) on delete set null;
alter table transactions add column if not exists discount_rate numeric(5,2) not null default 0;
alter table transactions add column if not exists discount_amount numeric(12,2) not null default 0;
alter table transactions add column if not exists discount_label varchar(160) null;
alter table transactions add column if not exists discount_program_id bigint null references discount_programs(id) on delete set null;
alter table transactions add column if not exists voucher_code varchar(80) null;
alter table transactions add column if not exists customer_phone varchar(40) null;
alter table main_stock add column if not exists branch_id bigint null references branches(id) on delete set null;
alter table stock_requests add column if not exists branch_id bigint null references branches(id) on delete set null;
alter table dining_tables drop constraint if exists dining_tables_table_number_key;
create unique index if not exists unique_dining_table_branch_number on dining_tables(branch_id, table_number);

create index if not exists idx_attendance_date on attendance(date);
create index if not exists idx_attendance_user_date on attendance(user_id, date);
create index if not exists idx_main_stock_type on main_stock(type);
create index if not exists idx_main_stock_source on main_stock(source);
create index if not exists idx_main_stock_created_at on main_stock(created_at);
create index if not exists idx_main_stock_item on main_stock(stock_item_id);
create index if not exists idx_main_stock_branch on main_stock(branch_id);
create index if not exists idx_stock_requests_status on stock_requests(status);
create index if not exists idx_stock_requests_date on stock_requests(date);
create index if not exists idx_stock_requests_branch on stock_requests(branch_id);
create index if not exists idx_transactions_branch on transactions(branch_id);
create index if not exists idx_website_settings_setting_key on website_settings(setting_key);
create index if not exists idx_stock_request_audit_request_id on stock_request_audit(request_id);
create index if not exists idx_stock_request_audit_action on stock_request_audit(action);
create index if not exists idx_stock_request_audit_created_at on stock_request_audit(created_at);
create index if not exists idx_dining_tables_status on dining_tables(status);
create index if not exists idx_dining_tables_branch on dining_tables(branch_id);
create index if not exists idx_dining_tables_qr_token on dining_tables(qr_token);
create index if not exists idx_customer_orders_status on customer_orders(status);
create index if not exists idx_customer_orders_table_id on customer_orders(table_id);
create index if not exists idx_customer_orders_branch on customer_orders(branch_id);
create index if not exists idx_customer_orders_created_at on customer_orders(created_at);
create index if not exists idx_customer_order_items_order_id on customer_order_items(order_id);
create index if not exists idx_discount_redemptions_phone on discount_redemptions(program_id, normalized_phone);
create index if not exists idx_discount_redemptions_transaction on discount_redemptions(transaction_id);
create index if not exists idx_discount_redemptions_order on discount_redemptions(order_id);

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

drop trigger if exists set_branches_updated_at on branches;
create trigger set_branches_updated_at
before update on branches
for each row execute function set_updated_at();

drop trigger if exists set_dining_tables_updated_at on dining_tables;
create trigger set_dining_tables_updated_at
before update on dining_tables
for each row execute function set_updated_at();

drop trigger if exists set_customer_orders_updated_at on customer_orders;
create trigger set_customer_orders_updated_at
before update on customer_orders
for each row execute function set_updated_at();

drop trigger if exists set_discount_programs_updated_at on discount_programs;
create trigger set_discount_programs_updated_at
before update on discount_programs
for each row execute function set_updated_at();

insert into dining_tables (table_number, table_name, capacity, qr_token, status)
select
  lpad(gs::text, 2, '0'),
  'Meja ' || gs::text,
  case when gs <= 4 then 2 else 4 end,
  encode(gen_random_bytes(24), 'hex'),
  'active'
from generate_series(1, 8) as gs
where not exists (select 1 from dining_tables limit 1);

update users set default_branch_id = (select id from branches order by id limit 1) where default_branch_id is null;
update dining_tables set branch_id = (select id from branches order by id limit 1) where branch_id is null;
update customer_orders set branch_id = (select id from branches order by id limit 1) where branch_id is null;
update transactions set branch_id = (select id from branches order by id limit 1) where branch_id is null;
update main_stock set branch_id = (select id from branches order by id limit 1) where branch_id is null;
update stock_requests set branch_id = (select id from branches order by id limit 1) where branch_id is null;

insert into discount_programs
  (name, type, discount_type, discount_value, usage_limit_per_phone, min_service_rating, min_menu_rating, status, note)
select
  'Reward Review Pelanggan', 'review_reward', 'percent', 5, 1, 1, 1, 'active',
  'Diskon otomatis setelah pelanggan memberi rating pelayanan dan menu pesanan.'
where not exists (select 1 from discount_programs where type = 'review_reward');
