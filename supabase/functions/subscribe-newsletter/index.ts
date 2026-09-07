// ═══════════════════════════════════════════════════════════════════
// Supabase Edge Function · subscribe-newsletter
// Mirrors the existing submit-case pattern:
//   • the public site calls this with the ANON key in headers
//   • the function uses SUPABASE_SERVICE_ROLE_KEY (server-side only)
//   • the service-role key is NEVER sent to the browser
// Deploy:  supabase functions deploy subscribe-newsletter
// ═══════════════════════════════════════════════════════════════════
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*", // tighten to your domain in prod if you prefer
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "invalid" }, 400); }

  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return json({ error: "invalid" }, 400);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // already subscribed?
  const { data: existing } = await supabase
    .from("newsletter_subscribers")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (existing) return json({ status: "already" });

  const { error } = await supabase.from("newsletter_subscribers").insert({
    email,
    active: true,
    source: typeof body.source === "string" ? String(body.source).slice(0, 60) : "website",
    lang: body.lang === "ar" ? "ar" : "en",
  });

  if (error) {
    // unique-index race -> treat as already subscribed
    if ((error as { code?: string }).code === "23505") return json({ status: "already" });
    return json({ error: "server" }, 500);
  }

  return json({ status: "subscribed" });
});
