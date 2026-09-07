/* ─────────────────────────────────────────────────────────────
 * MediVia — Supabase configuration (PUBLIC values only)
 *
 * These two values are safe to ship in the browser:
 *   · SUPABASE_URL       — your project URL
 *   · SUPABASE_ANON_KEY  — the "anon public" key (protected by RLS)
 *
 * NEVER put the service_role key here or anywhere in frontend code.
 * Replace the two placeholders below with your project's values from
 * Supabase → Project Settings → API.
 * ───────────────────────────────────────────────────────────── */
window.MEDIVIA_CONFIG = {
  SUPABASE_URL: "https://nkavhvsodgykkjirvzhl.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rYXZodnNvZGd5a2tqaXJ2emhsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgxODkwNDUsImV4cCI6MjEwMzc2NTA0NX0.YibL9jIds_LYpGm03MWJxKFn-expYCUcys_U9Zu8j3I",
  NEWSLETTER_URL: 'https://nkavhvsodgykkjirvzhl.supabase.co/functions/v1/subscribe-newsletter',
  YOUTUBE_ID: '1FuKLTJtXJo'

};


/* Derived endpoint for the intake Edge Function. */
window.MEDIVIA_CONFIG.SUBMIT_URL =
  window.MEDIVIA_CONFIG.SUPABASE_URL.replace(/\/+$/, "") + "/functions/v1/submit-case";
