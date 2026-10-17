-- BENGU 4.17: ganhos estimados, comissão do Bengu, pedidos de levantamento e lives.
-- Pode ser executado mais de uma vez. Não apaga dados. Executar DEPOIS do 4.16.
-- PRESSUPOSTOS: posts(user_id,views,created_at), follows(follower_id,following_id),
-- public.is_admin(), e do 4.16: bengu_notify(), bengu_admin_id(), bengu_name().
-- NOTA: este SQL não move dinheiro. Regista pedidos; o pagamento só é automático
-- depois de ligar os fornecedores (M-Pesa, e-Mola, mKesh, PayPal, banco/cartões).

-- ============ 1) DEFINIÇÕES (só o administrador altera, por função) ============
create table if not exists public.bengu_settings (key text primary key, value text not null);
alter table public.bengu_settings enable row level security;
insert into public.bengu_settings (key, value) values
  ('rpm_usd', '1.00'),            -- US$ estimados por 1000 visualizações (valor provisório: ajustar no painel)
  ('commission_pct', '20'),       -- parte do Bengu
  ('min_withdraw_usd', '10'),
  ('min_followers', '5000'),
  ('min_views_30d', '30000')
on conflict (key) do nothing;

create or replace function public.bengu_setting(k text) returns numeric
language sql stable security definer set search_path = public as $$
  select value::numeric from public.bengu_settings where key = k $$;
revoke all on function public.bengu_setting(text) from public, anon, authenticated;

-- ============ 2) BASE DE CÁLCULO POR CRIADOR ============
create or replace function public.bengu_creator_base()
returns table (cb_uid uuid, cb_views bigint, cb_views30 bigint, cb_followers bigint, cb_ok boolean, cb_gross numeric)
language sql stable security definer set search_path = public as $$
  with p as (
    select user_id, sum(coalesce(views,0))::bigint v,
           sum(case when created_at >= now() - interval '30 days' then coalesce(views,0) else 0 end)::bigint v30
    from public.posts group by user_id),
  f as (select following_id uid, count(*)::bigint c from public.follows group by following_id)
  select p.user_id, p.v, p.v30, coalesce(f.c,0),
         (coalesce(f.c,0) >= public.bengu_setting('min_followers') and p.v30 >= public.bengu_setting('min_views_30d')),
         round(p.v / 1000.0 * public.bengu_setting('rpm_usd'), 2)
  from p left join f on f.uid = p.user_id $$;
revoke all on function public.bengu_creator_base() from public, anon, authenticated;

create or replace function public.bengu_series(p_user uuid, p_unit text, p_n int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  if p_unit not in ('day','week','month') or p_n < 1 or p_n > 60 then raise exception 'parâmetros inválidos'; end if;
  execute format($q$
    select coalesce(jsonb_agg(jsonb_build_object('t', to_char(g,'YYYY-MM-DD'), 'views', coalesce(v.s,0), 'posts', coalesce(v.c,0)) order by g), '[]'::jsonb)
    from generate_series(date_trunc(%L, now()) - (%s) * ('1 ' || %L)::interval, date_trunc(%L, now()), ('1 ' || %L)::interval) g
    left join (select date_trunc(%L, created_at) d, sum(coalesce(views,0))::bigint s, count(*) c
               from public.posts where user_id = $1 group by 1) v on v.d = g
  $q$, p_unit, p_n - 1, p_unit, p_unit, p_unit, p_unit) into r using p_user;
  return r;
end $$;
revoke all on function public.bengu_series(uuid, text, int) from public, anon, authenticated;

-- ============ 3) LEVANTAMENTOS ============
create table if not exists public.bengu_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  method text not null check (method in ('mpesa','emola','mkesh','visa','mastercard','paypal')),
  account text not null check (char_length(account) between 3 and 80),
  amount_usd numeric(12,2) not null check (amount_usd > 0),
  status text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  note text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists bengu_withdrawals_user_idx on public.bengu_withdrawals (user_id, created_at desc);
create index if not exists bengu_withdrawals_status_idx on public.bengu_withdrawals (status, created_at);
alter table public.bengu_withdrawals enable row level security;
drop policy if exists wd_ler on public.bengu_withdrawals;
create policy wd_ler on public.bengu_withdrawals for select to authenticated using (user_id = auth.uid() or public.is_admin());
revoke all on public.bengu_withdrawals from anon, authenticated;
grant select on public.bengu_withdrawals to authenticated;

-- ============ 4) PAINEL DO CRIADOR (próprio ou, para o administrador, de qualquer utilizador) ============
create or replace function public.bengu_creator_stats(p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  uid uuid := coalesce(p_user, auth.uid());
  b record; taken numeric; fser jsonb := '[]'::jsonb;
  pct numeric := public.bengu_setting('commission_pct');
  rpm numeric := public.bengu_setting('rpm_usd');
  net numeric;
begin
  if auth.uid() is null then raise exception 'sem sessão'; end if;
  if uid <> auth.uid() and not public.is_admin() then raise exception 'sem permissão'; end if;
  select * into b from public.bengu_creator_base() where cb_uid = uid;
  select coalesce(sum(amount_usd),0) into taken from public.bengu_withdrawals where user_id = uid and status <> 'rejected';
  net := round(coalesce(b.cb_gross,0) * (100 - pct) / 100, 2);
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='follows' and column_name='created_at') then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('t', to_char(g,'YYYY-MM-DD'), 'n', coalesce(c.n,0)) order by g), '[]'::jsonb)
      from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') g
      left join (select date_trunc('month', created_at) d, count(*) n from public.follows where following_id = $1 group by 1) c on c.d = g
    $q$ into fser using uid;
  end if;
  return jsonb_build_object(
    'followers', coalesce(b.cb_followers, (select count(*) from public.follows where following_id = uid)),
    'views', coalesce(b.cb_views,0), 'views30', coalesce(b.cb_views30,0),
    'eligible', coalesce(b.cb_ok,false),
    'min_followers', public.bengu_setting('min_followers'), 'min_views30', public.bengu_setting('min_views_30d'),
    'rpm', rpm, 'creator_pct', 100 - pct, 'min_withdraw', public.bengu_setting('min_withdraw_usd'),
    'net_total', net, 'taken', taken,
    'available', case when coalesce(b.cb_ok,false) then greatest(net - taken, 0) else 0 end,
    'days', public.bengu_series(uid,'day',30), 'weeks', public.bengu_series(uid,'week',12),
    'months', public.bengu_series(uid,'month',12), 'followers_months', fser);
end $$;

create or replace function public.bengu_request_withdrawal(p_method text, p_account text, p_amount numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid(); s jsonb; wid uuid; acc text := btrim(coalesce(p_account,''));
begin
  if uid is null then raise exception 'sem sessão'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text));
  if p_method not in ('mpesa','emola','mkesh','visa','mastercard','paypal') then raise exception 'método inválido'; end if;
  if p_method in ('mpesa','emola','mkesh') and acc !~ '^258[0-9]{9}$' then raise exception 'número inválido (use 258XXXXXXXXX)'; end if;
  if p_method = 'paypal' and acc !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'e-mail do PayPal inválido'; end if;
  if p_method in ('visa','mastercard') and char_length(acc) < 8 then raise exception 'conta/cartão inválido'; end if;
  if p_amount is null or p_amount < public.bengu_setting('min_withdraw_usd') then raise exception 'valor abaixo do mínimo'; end if;
  s := public.bengu_creator_stats(uid);
  if not (s->>'eligible')::boolean then raise exception 'conta ainda não elegível'; end if;
  if p_amount > (s->>'available')::numeric then raise exception 'saldo insuficiente'; end if;
  insert into public.bengu_withdrawals (user_id, method, account, amount_usd) values (uid, p_method, acc, round(p_amount,2)) returning bengu_withdrawals.id into wid;
  perform public.bengu_notify(public.bengu_admin_id(), 'withdraw', 'Novo pedido de levantamento',
    public.bengu_name(uid) || ' pediu ' || round(p_amount,2) || ' US$ por ' || p_method, wid::text, 'wd:' || wid);
  return jsonb_build_object('ok', true, 'id', wid);
end $$;

-- ============ 5) ADMINISTRADOR: COMISSÃO E PEDIDOS ============
create or replace function public.bengu_admin_commission() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare pct numeric := public.bengu_setting('commission_pct'); g numeric; n int; ser jsonb; pend numeric; pendn int; paid numeric;
begin
  if not public.is_admin() then raise exception 'sem permissão'; end if;
  select count(*) filter (where cb_ok), coalesce(sum(cb_gross) filter (where cb_ok),0) into n, g from public.bengu_creator_base();
  select coalesce(sum(amount_usd) filter (where status in ('pending','approved')),0),
         count(*) filter (where status = 'pending'),
         coalesce(sum(amount_usd) filter (where status = 'paid'),0) into pend, pendn, paid from public.bengu_withdrawals;
  select coalesce(jsonb_agg(jsonb_build_object('t', to_char(m,'YYYY-MM-DD'), 'v', round(coalesce(x.s,0) / 1000.0 * public.bengu_setting('rpm_usd') * pct / 100, 2)) order by m), '[]'::jsonb) into ser
  from generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m
  left join (select date_trunc('month', p.created_at) d, sum(coalesce(p.views,0)) s
             from public.posts p join public.bengu_creator_base() b on b.cb_uid = p.user_id and b.cb_ok group by 1) x on x.d = m;
  return jsonb_build_object('eligible_creators', n, 'gross', g, 'bengu_pct', pct,
    'bengu_commission', round(g * pct / 100, 2), 'creators_total', round(g * (100 - pct) / 100, 2),
    'pending_amount', pend, 'pending_count', pendn, 'paid_amount', paid,
    'rpm', public.bengu_setting('rpm_usd'), 'min_withdraw', public.bengu_setting('min_withdraw_usd'), 'months', ser);
end $$;

create or replace function public.bengu_admin_withdrawals() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'sem permissão'; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by (r.status = 'pending') desc, r.created_at desc) from (
    select w.id, w.user_id, public.bengu_name(w.user_id) as name, w.method, w.account, w.amount_usd, w.status, w.note, w.created_at
    from public.bengu_withdrawals w order by w.created_at desc limit 100) r), '[]'::jsonb);
end $$;

create or replace function public.bengu_admin_set_withdrawal(p_id uuid, p_status text, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare w public.bengu_withdrawals;
begin
  if not public.is_admin() then raise exception 'sem permissão'; end if;
  if p_status not in ('approved','paid','rejected') then raise exception 'estado inválido'; end if;
  update public.bengu_withdrawals set status = p_status, note = left(p_note, 200), processed_at = now()
    where id = p_id and status in ('pending','approved') returning * into w;
  if w.id is null then raise exception 'pedido não encontrado ou já fechado'; end if;
  perform public.bengu_notify(w.user_id, 'withdraw', case p_status when 'paid' then 'Levantamento pago' when 'approved' then 'Levantamento aprovado' else 'Levantamento recusado' end,
    w.amount_usd || ' US$ · ' || w.method || coalesce(' · ' || nullif(p_note,''), ''), w.id::text, 'wd:' || w.id || ':' || p_status);
end $$;

create or replace function public.bengu_admin_set_setting(p_key text, p_value numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'sem permissão'; end if;
  if p_key not in ('rpm_usd','commission_pct','min_withdraw_usd','min_followers','min_views_30d') then raise exception 'definição inválida'; end if;
  if p_value < 0 or (p_key = 'commission_pct' and p_value > 100) then raise exception 'valor inválido'; end if;
  update public.bengu_settings set value = p_value::text where key = p_key;
end $$;

-- ============ 6) REEL AO VIVO (registo; o vídeo exige um fornecedor de streaming) ============
create table if not exists public.bengu_lives (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  filter text not null default 'none',
  status text not null default 'live' check (status in ('live','ended')),
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists bengu_lives_status_idx on public.bengu_lives (status, last_seen desc);
alter table public.bengu_lives enable row level security;
drop policy if exists lives_ler on public.bengu_lives;
create policy lives_ler on public.bengu_lives for select to authenticated using (true);
drop policy if exists lives_inserir on public.bengu_lives;
create policy lives_inserir on public.bengu_lives for insert to authenticated with check (host_id = auth.uid());
drop policy if exists lives_atualizar on public.bengu_lives;
create policy lives_atualizar on public.bengu_lives for update to authenticated using (host_id = auth.uid()) with check (host_id = auth.uid());
revoke all on public.bengu_lives from anon, authenticated;
grant select, insert on public.bengu_lives to authenticated;
grant update (filter, status, last_seen, ended_at) on public.bengu_lives to authenticated;

-- ============ 7) PERMISSÕES DAS FUNÇÕES ============
revoke all on function public.bengu_creator_stats(uuid) from public, anon;
revoke all on function public.bengu_request_withdrawal(text, text, numeric) from public, anon;
revoke all on function public.bengu_admin_commission() from public, anon;
revoke all on function public.bengu_admin_withdrawals() from public, anon;
revoke all on function public.bengu_admin_set_withdrawal(uuid, text, text) from public, anon;
revoke all on function public.bengu_admin_set_setting(text, numeric) from public, anon;
grant execute on function public.bengu_creator_stats(uuid) to authenticated;
grant execute on function public.bengu_request_withdrawal(text, text, numeric) to authenticated;
grant execute on function public.bengu_admin_commission() to authenticated;
grant execute on function public.bengu_admin_withdrawals() to authenticated;
grant execute on function public.bengu_admin_set_withdrawal(uuid, text, text) to authenticated;
grant execute on function public.bengu_admin_set_setting(text, numeric) to authenticated;
