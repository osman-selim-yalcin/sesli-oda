-- Çoklu oda: oda kayıtları, oda istekleri, oda üyeleri.
-- Canlıya geçerken Supabase SQL düzenleyicisinde bir kez elle çalıştırılır (sunucu çalıştırmaz).
-- accounts.id metindir: hesap adının tr-TR küçük harfli hali (accounts.js keyOf).
-- Sunucu gizli anahtarla (service role) bağlanır, RLS'yi aşar; politika yok, yani başka hiçbir
-- anahtar bu tablolara erişemez.

create table rooms (
  id text primary key,
  name text not null,
  owner_id text not null references accounts(id),
  pass_hash text,
  theme text not null default 'varsayilan',
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table room_requests (
  id bigint generated always as identity primary key,
  account_id text not null references accounts(id),
  name text not null,
  pass_hash text,
  theme text not null,
  note text not null default '',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

create table room_members (
  room_id text not null references rooms(id),
  account_id text not null references accounts(id),
  joined_at timestamptz not null default now(),
  primary key (room_id, account_id)
);

alter table rooms enable row level security;
alter table room_requests enable row level security;
alter table room_members enable row level security;
