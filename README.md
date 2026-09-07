# MediVia — patient intake MVP (Supabase)

Turns the existing intake forms from a fake submission into a real, working flow:

```
Patient → form → Edge Function (validate + store) → Postgres + private Storage
        → real MV-2026-XXXX reference → /admin dashboard → signed-URL file access
```

The existing frontend (design, responsive layout, EN/AR i18n, RTL, validation,
image previews, PDF upload, review step, success screen) is **unchanged** except
for the submission logic itself.

---

## What's in here

```
index.html                         # home page — 4-step intake, now wired to the backend
plastic-surgery.html               # treatment page — contact form, now wired to the backend
admin.html                         # NEW: admin dashboard (Supabase Auth + RLS)
js/supabase-config.js              # PUBLIC config (project URL + anon key) — you fill this in
supabase/
  config.toml                      # makes submit-case callable without a JWT
  migrations/0001_init.sql         # DB schema, triggers, RLS, storage bucket, admin table
  functions/submit-case/index.ts   # Edge Function: validate, store files, insert case
README.md
```

Your existing `js/i18n.js` stays exactly where it is; `js/supabase-config.js`
sits next to it in the same `js/` folder.

---

## Architecture (and why)

- **No separate backend server.** One Supabase Edge Function is the only server-side
  code. It holds the service-role key as a secret, does all validation, and is the
  only thing that writes to the database or storage.
- **The public site never sees the service-role key.** The browser only ever holds
  the anon public key, which is safe to expose because Row Level Security (RLS) gates
  everything.
- **Patient data is private by default.** RLS on `cases` grants access only to
  signed-in admins; the anon key can read nothing. The `case-files` storage bucket is
  private; files are reachable only through short-lived signed URLs an admin mints.
- **Reference numbers are minted server-side** by a database trigger + sequence, so
  they're unique and can't be forged by the client.

---

## 1) Create the Supabase project

1. Create a project at <https://supabase.com>.
2. Note, from **Project Settings → API**:
   - **Project URL** (e.g. `https://abcd1234.supabase.co`)
   - **anon public** key
   - **service_role** key (secret — used only by the Edge Function, never in the browser)

## 2) Run the database migration

**Option A — SQL editor (simplest):** open **SQL Editor**, paste the contents of
`supabase/migrations/0001_init.sql`, and run it.

**Option B — CLI:**
```bash
npm install -g supabase
supabase login
supabase link --project-ref <your-project-ref>
supabase db push          # applies supabase/migrations/*.sql
```

This creates: the `cases` table, the `MV-YYYY-NNNN` reference sequence + trigger,
the private `case-files` storage bucket, the `admins` allowlist, the `is_admin()`
helper, and all RLS policies.

## 3) Deploy the Edge Function

```bash
supabase functions deploy submit-case --no-verify-jwt
```

`--no-verify-jwt` (also set in `supabase/config.toml`) lets the public forms call it
without a user login. The function still validates every request itself.

The function reads these env vars, which Supabase injects automatically for deployed
functions: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Optionally set an allowed
origin to lock CORS to your domain:

```bash
supabase secrets set ALLOWED_ORIGIN=https://medical-via.com
```

(Default is `*`, which is fine for first testing. Restrict it before going live.)

## 4) Point the frontend at your project

Edit **`js/supabase-config.js`** and replace the two placeholders:

```js
window.MEDIVIA_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-PUBLIC-KEY"
};
```

Both values are public and safe in the browser. **Do not** put the service_role key here.

## 5) Create your admin account

1. **Authentication → Users → Add user** — create an email + password
   (e.g. `admin@medical-via.com`). Turn off public sign-ups under
   **Authentication → Providers → Email** if you like; it isn't required because the
   `admins` allowlist is what actually grants access.
2. Enrol that user as an admin. In the SQL editor:

   ```sql
   insert into public.admins (user_id, email)
   select id, email from auth.users
   where email = 'admin@medical-via.com'
   on conflict (user_id) do nothing;
   ```

Only users listed in `public.admins` can read cases or open files — even if other
auth users exist.

## 6) Deploy the static files

Host `index.html`, `plastic-surgery.html`, `admin.html`, and the `js/` folder on any
static host (the same place the site is already served — Netlify, Vercel, Cloudflare
Pages, Supabase Hosting, S3, etc.). No build step is required.

Then open `/admin.html`, sign in, and you'll see submitted cases.

---

## Environment variables at a glance

| Where | Name | Secret? | Purpose |
|---|---|---|---|
| `js/supabase-config.js` | `SUPABASE_URL` | no | project URL |
| `js/supabase-config.js` | `SUPABASE_ANON_KEY` | no | public anon key (RLS-gated) |
| Edge Function | `SUPABASE_URL` | no | auto-injected |
| Edge Function | `SUPABASE_SERVICE_ROLE_KEY` | **yes** | auto-injected; server-only |
| Edge Function | `ALLOWED_ORIGIN` | no | optional CORS lock-down |

---

## How the pieces enforce privacy

- **`cases` table:** RLS on; anon key gets nothing. Admin `SELECT`/`UPDATE` policies
  require `is_admin()`. Inserts happen only inside the Edge Function via the
  service-role key (which bypasses RLS).
- **`case-files` bucket:** private. Uploads happen only in the Edge Function.
  Admins get a `SELECT` policy so the dashboard can mint **signed URLs** (default
  5-minute expiry) — links expire and aren't publicly guessable.
- **Duplicate submissions:** each form load generates an `idempotencyKey`. The button
  is disabled on submit and re-enabled only on failure; the server also dedupes on a
  unique `idempotency_key`, returning the original reference instead of a second case.
- **Errors:** upload/DB failures roll back (the partial row and any uploaded files are
  removed) and the patient sees a clear message; the success screen shows **only**
  after the backend confirms and returns a reference.

## Case statuses

`new → reviewing → contacted → in_progress → completed → rejected`
(enforced by a DB `CHECK`; changed from the admin case drawer.)

---

## What was tested before hand-off

- **SQL migration** applied to a real PostgreSQL 16 instance: tables, sequence,
  reference trigger (`MV-2026-1000`, `MV-2026-1001`…), `updated_at` trigger, all RLS
  policies, and every `CHECK` constraint (invalid status/age rejected; duplicate
  `idempotency_key` rejected).
- **Edge Function** run end-to-end under Node against a mock Supabase client — 21
  checks covering: valid submission with 3 images + PDF, reference format, row +
  file-metadata persistence, idempotent re-submit, and every validation/error branch
  (missing fields, short details, bad age, missing consent, too many images, oversized
  image, bad image/PDF type, CORS preflight, no-files submission).
- **Both forms + admin**: all DOM selectors resolve; all inline scripts pass a JS
  syntax check; the client sends exactly the multipart field names the function reads.

## A note on compliance

This implements sensible technical security (private storage, RLS, server-side
validation, signed URLs, no secret keys in the browser). It is **not** a claim of legal
compliance with HIPAA, GDPR, or Russian data-protection law. Handling real patient
data means signing the appropriate data-processing agreements, setting data-retention
and deletion policies, restricting the storage region, and getting a proper legal
review before launch.

## Deliberately out of scope (per the MVP brief)

CRM, automation, analytics, WhatsApp integration, and email notifications. The schema
leaves room to add them later without migration pain.
