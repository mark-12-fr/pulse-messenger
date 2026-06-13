// clear-media — deletes media files older than the start of "today" (Manila/UTC+8)
// from the `media` storage bucket. Invoked daily by a pg_cron job. Uses the
// service-role key that Supabase injects automatically, so no secrets are hardcoded.
//
// This is already deployed to your Supabase project. To redeploy after editing:
//   supabase functions deploy clear-media
import { createClient } from "npm:@supabase/supabase-js@2";

const BUCKET = "media";
const TZ_OFFSET_HOURS = 8; // Asia/Manila

Deno.serve(async (_req: Request) => {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(url, serviceKey);

    // Start of today in Manila, expressed as a UTC millisecond timestamp.
    const manila = new Date(Date.now() + TZ_OFFSET_HOURS * 3600_000);
    const manilaMidnightUtcMs = Date.UTC(
      manila.getUTCFullYear(), manila.getUTCMonth(), manila.getUTCDate(), 0, 0, 0,
    );
    const boundaryMs = manilaMidnightUtcMs - TZ_OFFSET_HOURS * 3600_000;

    const toDelete: string[] = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase.storage.from(BUCKET).list("", {
        limit: pageSize,
        offset,
        sortBy: { column: "created_at", order: "asc" },
      });
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const f of data) {
        if (!f.name) continue;
        const ts = f.created_at ? Date.parse(f.created_at) : 0;
        if (ts < boundaryMs) toDelete.push(f.name);
      }
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    let removed = 0;
    for (let i = 0; i < toDelete.length; i += 100) {
      const batch = toDelete.slice(i, i + 100);
      const { error } = await supabase.storage.from(BUCKET).remove(batch);
      if (error) throw error;
      removed += batch.length;
    }

    return new Response(JSON.stringify({ ok: true, removed }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
