create table if not exists public.snapshots (
  period text not null,
  region text not null,
  hyOAS numeric,
  fci numeric,
  pmi numeric,
  dxy numeric,
  bookBill numeric,
  defaults numeric,
  unemployment numeric,
  riskScore numeric,
  signal text,
  primary key (period, region)
);
