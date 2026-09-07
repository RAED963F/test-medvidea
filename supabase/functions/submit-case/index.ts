// ════════════════════════════════════════════════════════════════════════
//  MediVia — submit-case Edge Function (Deno)
//
//  Public endpoint the intake forms POST to. It:
//    1. parses multipart/form-data
//    2. validates every field + file server-side
//    3. inserts the case (DB trigger mints the MV-YYYY-NNNN reference)
//    4. uploads images + PDF to the PRIVATE `case-files` bucket
//    5. returns { reference }
//
//  Uses the service-role key (server-side secret) so it bypasses RLS.
//  Deploy WITHOUT JWT verification so the public site can call it:
//    supabase functions deploy submit-case --no-verify-jwt
//  (or set verify_jwt = false in supabase/config.toml — included here.)
// ════════════════════════════════════════════════════════════════════════

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL  = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Restrict this to your real site origin in production, e.g.
// "https://medical-via.com". "*" is fine for local testing.
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const BUCKET          = "case-files";
const MAX_IMAGES      = 5;
const MAX_IMG_BYTES   = 10 * 1024 * 1024; // 10 MB
const MAX_PDF_BYTES   = 10 * 1024 * 1024; // 10 MB
const IMG_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"];
const IMG_EXT   = /\.(jpe?g|png|webp|heic|heif)$/i;

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sanitizeName(name: string): string {
  return (name || "file").replace(/[^\w.\-]+/g, "_").slice(-80) || "file";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")   return json(405, { error: "method_not_allowed" });

  // ── parse body ──────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json(400, { error: "invalid_form_data" });
  }

  const str = (k: string) => (form.get(k) ?? "").toString().trim();

  const firstName   = str("firstName");
  const lastName    = str("lastName");
  const nationality = str("nationality");
  const ageRaw      = str("age");
  const sex         = str("sex");
  const whatsapp    = str("whatsapp");
  const email       = str("email");
  const reason      = str("reason");
  const details     = str("details");
  const consent     = ["true", "on", "1", "yes"].includes(str("consent").toLowerCase());
  const source      = str("source") || "website";
  const submittedAt = str("submittedAt") || null;
  const idem        = str("idempotencyKey") || null;

  // ── validate text fields ────────────────────────────────────
  const fields: string[] = [];
  const age = Number(ageRaw);
  if (!firstName   || firstName.length   > 80)  fields.push("firstName");
  if (!lastName    || lastName.length    > 80)  fields.push("lastName");
  if (!nationality || nationality.length > 80)  fields.push("nationality");
  if (!ageRaw || !Number.isFinite(age) || age < 0 || age > 120) fields.push("age");
  if (sex !== "male" && sex !== "female")       fields.push("sex");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fields.push("email");
  if (whatsapp && whatsapp.length > 40)         fields.push("whatsapp");
  if (!reason || reason.length > 140)           fields.push("reason");
  if (!details || details.length < 30 || details.length > 4000) fields.push("details");
  if (!consent)                                 fields.push("consent");
  if (fields.length) return json(400, { error: "validation", fields });

  // ── collect + validate files ────────────────────────────────
  const imageFiles: File[] = [];
  for (const [k, v] of form.entries()) {
    if (v instanceof File && v.size > 0 && (k === "images" || k.startsWith("images["))) {
      imageFiles.push(v);
    }
  }
  if (imageFiles.length > MAX_IMAGES) return json(400, { error: "too_many_images" });
  for (const f of imageFiles) {
    if (f.size > MAX_IMG_BYTES) return json(400, { error: "image_too_large", name: f.name });
    const okType = IMG_TYPES.includes((f.type || "").toLowerCase()) || IMG_EXT.test(f.name);
    if (!okType) return json(400, { error: "image_bad_type", name: f.name });
  }

  let reportFile: File | null = null;
  const report = form.get("report");
  if (report instanceof File && report.size > 0) {
    if (report.size > MAX_PDF_BYTES) return json(400, { error: "pdf_too_large" });
    const okPdf = (report.type || "") === "application/pdf" || /\.pdf$/i.test(report.name);
    if (!okPdf) return json(400, { error: "pdf_bad_type" });
    reportFile = report;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ── idempotency: already submitted with this key? ───────────
  if (idem) {
    const { data: existing } = await admin
      .from("cases").select("reference").eq("idempotency_key", idem).maybeSingle();
    if (existing) return json(200, { reference: existing.reference, duplicate: true });
  }

  // ── request metadata ────────────────────────────────────────
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const ua = req.headers.get("user-agent") ?? null;
  const ipHash = ip ? await sha256Hex(ip + "|medivia") : null;

  // ── insert the case (trigger mints the reference) ───────────
  const { data: created, error: insErr } = await admin
    .from("cases")
    .insert({
      first_name: firstName,
      last_name: lastName,
      nationality,
      age,
      sex,
      whatsapp: whatsapp || null,
      email: email || null,
      reason,
      details,
      consent,
      source,
      idempotency_key: idem,
      ip_hash: ipHash,
      user_agent: ua,
      submitted_at: submittedAt,
    })
    .select("id, reference")
    .single();

  if (insErr) {
    // Unique-violation race on idempotency_key → return the winner's ref.
    if ((insErr as { code?: string }).code === "23505" && idem) {
      const { data: ex } = await admin
        .from("cases").select("reference").eq("idempotency_key", idem).maybeSingle();
      if (ex) return json(200, { reference: ex.reference, duplicate: true });
    }
    console.error("insert failed:", insErr);
    return json(500, { error: "db_insert_failed" });
  }

  const caseId = created!.id as string;
  const ref    = created!.reference as string;

  // ── upload files; roll back the row if anything fails ───────
  const uploadedPaths: string[] = [];
  try {
    const images: Array<{ path: string; name: string; size: number; type: string | null }> = [];
    let i = 0;
    for (const f of imageFiles) {
      i++;
      const path = `${ref}/images/${String(i).padStart(2, "0")}-${sanitizeName(f.name)}`;
      const bytes = new Uint8Array(await f.arrayBuffer());
      const { error } = await admin.storage.from(BUCKET)
        .upload(path, bytes, { contentType: f.type || "application/octet-stream", upsert: false });
      if (error) throw error;
      uploadedPaths.push(path);
      images.push({ path, name: f.name, size: f.size, type: f.type || null });
    }

    let reportMeta: { path: string; name: string; size: number } | null = null;
    if (reportFile) {
      const path = `${ref}/report.pdf`;
      const bytes = new Uint8Array(await reportFile.arrayBuffer());
      const { error } = await admin.storage.from(BUCKET)
        .upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (error) throw error;
      uploadedPaths.push(path);
      reportMeta = { path, name: reportFile.name, size: reportFile.size };
    }

    const { error: updErr } = await admin
      .from("cases").update({ images, report: reportMeta }).eq("id", caseId);
    if (updErr) throw updErr;
  } catch (e) {
    console.error("upload/rollback:", e);
    if (uploadedPaths.length) {
      await admin.storage.from(BUCKET).remove(uploadedPaths).catch(() => {});
    }
    await admin.from("cases").delete().eq("id", caseId).catch(() => {});
    return json(500, { error: "upload_failed" });
  }

  return json(200, { reference: ref });
});
