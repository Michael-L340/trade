-- tj_0001_init.sql
-- 交易日志（trade-journal）在记账同一个 Supabase 项目里的全部云端对象。
-- 用法：Supabase 控制台 → 记账那个项目 → SQL Editor → New query → 整段粘贴 → Run。
-- 可以重复运行：只补齐缺的东西，不删任何数据（删掉重建的只有策略和触发器，函数原地替换）。
-- 控制台弹出 destructive operation 提示时点 Run this query。
-- 本文件里所有对象都带 tj 前缀，不引用记账的任何表；记账的代码、迁移、备份也不引用这里的对象。

-- ───────── 0. 当前请求是不是一个真用户 ─────────
-- 匿名登录拿到的也是 authenticated 角色。控制台里已经关掉匿名登录，这里再挡一道：
-- 匿名会话返回 null，下面所有策略对它都不成立。
create or replace function public.tj_me()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then null
    else auth.uid()
  end
$$;

-- ───────── 1. 整本日志：每个用户一行 ─────────
-- doc 用 json 不用 jsonb：json 按原文保存，不重排键。
-- user_id 引用 auth.users 但不级联删除：日志还在时，控制台删不掉这个用户，防止误删用户连带删掉日志。
create table if not exists public.tj_journal (
  user_id    uuid primary key default auth.uid() references auth.users (id),
  doc        json not null,
  rev        bigint not null check (rev >= 1),
  updated_at timestamptz not null default now()
);

alter table public.tj_journal enable row level security;

drop policy if exists tj_journal_select on public.tj_journal;
create policy tj_journal_select on public.tj_journal
  for select to authenticated
  using (user_id = (select public.tj_me()));

drop policy if exists tj_journal_insert on public.tj_journal;
create policy tj_journal_insert on public.tj_journal
  for insert to authenticated
  with check (user_id = (select public.tj_me()));

drop policy if exists tj_journal_update on public.tj_journal;
create policy tj_journal_update on public.tj_journal
  for update to authenticated
  using (user_id = (select public.tj_me()))
  with check (user_id = (select public.tj_me()));
-- 故意没有 delete 策略，也不授 delete 权限：网站和备份脚本都删不掉这一行。

-- 2026-10-30 起新表不再自动开放给 Data API，权限必须显式写。
revoke all on table public.tj_journal from anon, authenticated;
grant select, insert, update on table public.tj_journal to authenticated;

-- ───────── 2. 历史版本：被覆盖的旧 doc，每个用户只留最近 30 份 ─────────
create table if not exists public.tj_journal_history (
  id          bigint generated always as identity primary key,
  user_id     uuid not null,
  rev         bigint not null,
  doc         json not null,
  saved_at    timestamptz not null,               -- 这份旧 doc 当初保存的时间
  replaced_at timestamptz not null default now()  -- 它被新版本盖掉的时间
);
create index if not exists tj_journal_history_user_id
  on public.tj_journal_history (user_id, id desc);

alter table public.tj_journal_history enable row level security;

drop policy if exists tj_journal_history_select on public.tj_journal_history;
create policy tj_journal_history_select on public.tj_journal_history
  for select to authenticated
  using (user_id = (select public.tj_me()));
-- 网站只能读；写入和清理都由下面的触发器做。
revoke all on table public.tj_journal_history from anon, authenticated;
grant select on table public.tj_journal_history to authenticated;

-- ───────── 3. 触发器：rev 只能 +1；旧版本进历史表 ─────────
-- 报错用 SQLSTATE PT409：PostgREST 把它转成 HTTP 409，网站按"冲突"处理。
create or replace function public.tj_journal_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.rev <> 1 then
      raise exception 'tj_journal: 第一次保存 rev 必须是 1，收到 %', new.rev
        using errcode = 'PT409';
    end if;
    new.updated_at := now();
    return new;
  end if;

  if new.rev is distinct from old.rev + 1 then
    raise exception 'tj_journal: rev 必须是 % + 1，收到 %', old.rev, new.rev
      using errcode = 'PT409';
  end if;
  new.updated_at := now();

  insert into public.tj_journal_history (user_id, rev, doc, saved_at)
  values (old.user_id, old.rev, old.doc, old.updated_at);

  -- 按写入顺序（id）只留最近 30 份。不按 rev 排：那一行被删后重建，rev 会从 1 重新数。
  delete from public.tj_journal_history
   where id in (
     select id
       from public.tj_journal_history
      where user_id = old.user_id
      order by id desc
     offset 30
   );

  return new;
end;
$$;
revoke all on function public.tj_journal_guard() from public, anon, authenticated;

drop trigger if exists tj_journal_guard on public.tj_journal;
create trigger tj_journal_guard
  before insert or update on public.tj_journal
  for each row execute function public.tj_journal_guard();

-- ───────── 4. 截图桶：私有，单个文件不超过 300 KB，只收 webp 和 jpeg ─────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tj-shots', 'tj-shots', false, 307200, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ───────── 5. 用量：本项目 Storage 里真实的字节数（含没被引用的孤儿文件） ─────────
-- security definer：要数到桶里的全部文件，不受调用者自己的 RLS 限制。
-- 拒收按全项目合计算：记账目前没用 Storage，所以现在它就等于 tj-shots 桶的用量；
-- 以后记账也往 Storage 放东西，这道闸照样守得住 1 GB。
create or replace function public.tj_storage_bytes()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint
    from storage.objects
$$;

-- 设置页显示用。合计直接调 tj_storage_bytes()，和插入策略永远是同一个数（模拟满额时也一样）。
create or replace function public.tj_storage_usage()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'tj_shots_bytes', coalesce(sum((metadata ->> 'size')::bigint) filter (where bucket_id = 'tj-shots'), 0),
    'tj_shots_files', count(*) filter (where bucket_id = 'tj-shots'),
    'project_bytes',  public.tj_storage_bytes(),
    'warn_bytes',     800000000,
    'limit_bytes',    900000000
  )
    from storage.objects
$$;

revoke all on function public.tj_me(), public.tj_storage_bytes(), public.tj_storage_usage()
  from public, anon;
grant execute on function public.tj_me(), public.tj_storage_bytes(), public.tj_storage_usage()
  to authenticated;

-- ───────── 6. 截图桶的两条策略 ─────────
-- 对象名：<user_id>/shots/<交易id>/<截图id>.webp，第一层目录必须是自己的 user_id。
-- 不建 update、delete 策略：网站代码写错也覆盖不了、删不掉云端截图。
drop policy if exists tj_shots_select on storage.objects;
create policy tj_shots_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tj-shots'
    and (storage.foldername(name))[1] = (select public.tj_me())::text
  );

-- 900 MB 硬上限：全项目 Storage 合计到 9 亿字节后，服务端拒收一切新截图。
drop policy if exists tj_shots_insert on storage.objects;
create policy tj_shots_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'tj-shots'
    and (storage.foldername(name))[1] = (select public.tj_me())::text
    and (select public.tj_storage_bytes()) < 900000000
  );

-- ───────── 自检：跑完后去掉下面每句开头的 "-- "，逐句选中后点 Run selected（整段一起跑只显示最后一句的结果），结果应和注释一致 ─────────
-- select relname, relrowsecurity from pg_class
--  where relname in ('tj_journal', 'tj_journal_history');          -- 两行，relrowsecurity 都是 true
-- select tablename, policyname, cmd from pg_policies
--  where policyname like 'tj\_%' order by 1, 2;                     -- 6 行
-- select policyname, cmd from pg_policies
--  where schemaname = 'storage' and tablename = 'objects';          -- 只有 tj_shots_select（SELECT）和 tj_shots_insert（INSERT）
--                                                                   -- 多出别的就停下告诉用户：别的宽松 insert 策略会架空 900 MB 的闸
-- select grantee, string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
--  where table_name = 'tj_journal' and grantee in ('anon', 'authenticated') group by 1;
--                                                                   -- 只有 authenticated：INSERT,SELECT,UPDATE
-- select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'tj-shots';
--                                                                   -- false, 307200, {image/webp,image/jpeg}
-- select public.tj_storage_usage();                                 -- 还没传过截图时，各项用量都是 0
