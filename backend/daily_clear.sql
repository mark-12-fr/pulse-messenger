-- ============================================================================
-- Daily auto-clearing chats (already applied to your Supabase project)
--
-- Every message is deleted at the start of each new day, so users always begin
-- the day with an empty chat. This runs inside Postgres via pg_cron, so it works
-- even when the backend (Render free tier) is asleep.
--
-- Timezone is Asia/Manila (UTC+8). Change 'Asia/Manila' below and the cron hour
-- if you need a different timezone. The cron schedule is in UTC:
--   00:00 Manila == 16:00 UTC  ->  '0 16 * * *'
-- ============================================================================

create extension if not exists pg_cron;

create or replace function public.clear_daily_chats()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  boundary timestamptz := date_trunc('day', now() at time zone 'Asia/Manila') at time zone 'Asia/Manila';
begin
  delete from public.messages where created_at < boundary;
  delete from public.message_reads
    where last_read_message_id not in (select id from public.messages);
end;
$$;

-- Schedule it (runs daily at 00:00 Manila / 16:00 UTC):
select cron.schedule('clear-daily-chats', '0 16 * * *', $$ select public.clear_daily_chats(); $$);

-- ============================================================================
-- Daily media-file cleanup (photos / videos / files in the `media` bucket)
--
-- This deletes the actual files from Supabase Storage via the `clear-media`
-- Edge Function (source: supabase/functions/clear-media/index.ts), which is
-- invoked by pg_net on a schedule. The Edge Function uses the auto-injected
-- service-role key, so no secret is stored here — only the public anon key is
-- needed to invoke it.
-- ============================================================================
create extension if not exists pg_net;

select cron.schedule(
  'clear-daily-media',
  '0 16 * * *',
  $$
  select net.http_post(
    url := 'https://rwgadvtwbznhyrqoqbhd.supabase.co/functions/v1/clear-media',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- public anon key (Settings > API). Safe to expose; it only invokes the function.
      'Authorization', 'Bearer YOUR_SUPABASE_ANON_KEY'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Handy management commands:
--
--   -- See the scheduled job:
--   select jobid, jobname, schedule, active from cron.job;
--
--   -- See recent runs:
--   select * from cron.job_run_details order by start_time desc limit 10;
--
--   -- Clear the chat manually right now:
--   select public.clear_daily_chats();
--
--   -- Change the time (e.g. 3 AM Manila = 19:00 UTC the day before):
--   select cron.schedule('clear-daily-chats', '0 19 * * *', $$ select public.clear_daily_chats(); $$);
--
--   -- Turn the daily message clearing OFF:
--   select cron.unschedule('clear-daily-chats');
--
--   -- Turn the daily media clearing OFF:
--   select cron.unschedule('clear-daily-media');
-- ----------------------------------------------------------------------------
