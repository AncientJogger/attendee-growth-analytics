> **Shortcut.** You no longer need `/setup` or `SETUP_TOKEN`. Put the Supabase pooler URI in `DATABASE_URL`, add `ANTHROPIC_API_KEY`, redeploy and open the site: an empty database is set up automatically on the first request. Without `DATABASE_URL` the app runs on its built-in demo database instead.

# Deployment guide (Supabase + Vercel)

Status: **not deployed yet.** The code builds and passes its tests locally, but this environment had no Supabase, Vercel or Anthropic credentials. Follow these steps to get a public link.

## What you need

- A Supabase account (free tier is enough).
- A Vercel account connected to the GitHub account that will hold this repo.
- An Anthropic API key (optional; without it the AI page shows "AI unavailable" and everything else works).
- Node 22+ on your machine to run migrations and the seed once.

## 1. Create the database

1. In Supabase, create a project. Note the database password.
2. Open Project Settings → Database → Connection string. Copy the **Transaction pooler** URI (port 6543). Replace `[YOUR-PASSWORD]` and append `?sslmode=require`.
3. On your machine, in the project folder:

```bash
npm install
cp .env.example .env.local
# edit .env.local: DATABASE_URL=<pooler URI>, SESSION_SECRET=$(openssl rand -base64 48)
npm run db:migrate
npm run db:seed
```

`db:migrate` creates the tables, the `fga_app` role, the RLS policies, and revokes Supabase's default `anon`/`authenticated` table access (the app never uses Supabase's REST API). `db:seed` imports `data/attendee-dataset.xlsx` and creates the demo users, initiatives, budget lines, tasks and experiments.

If `db:migrate` fails on `grant fga_app to current_user`, run the migration file `supabase/migrations/0002_rls.sql` once in the Supabase SQL editor (it runs as `postgres`), then rerun `npm run db:migrate`.

Check it worked, in the SQL editor:

```sql
select count(*) from people;             -- 3685
select label from dataset_versions;      -- CampusFest 2025 (supplied historical dataset)
select count(*) from pg_policies;        -- 60 or more
```

## 2. Deploy the app

1. Push this folder to a new GitHub repository.
2. In Vercel: Add New → Project → import the repo. Framework preset: Next.js. No build settings need changing.
3. Environment variables (Production and Preview):

| Name | Value |
|---|---|
| `DATABASE_URL` | the Supabase pooler URI with `?sslmode=require` |
| `DB_POOL_MAX` | `1` |
| `SESSION_SECRET` | the same 32+ character secret as above |
| `ANTHROPIC_API_KEY` | your key (optional) |
| `ANTHROPIC_MODEL` | optional, defaults to `claude-sonnet-5-5` |
| `SHOW_DEMO_LOGINS` | optional; `true` lists the demo accounts under the sign-in form (hidden by default) |

4. Deploy. The build runs `next build`; no database access is needed at build time.

Function limits to know about: the dataset import route allows up to 300 s (fine on Vercel's default fluid compute), and Vercel caps request bodies at 4.5 MB, so the app limits uploads to about 4 MB there. The supplied workbook is 1.5 MB.

## 3. Smoke test the live URL

1. Open the URL; you should land on the login page with the demo accounts listed.
2. Sign in as `admin@demo.fest` / `Demo-Admin-2026`. Overview should show 2,050 unique verified attendees, 2,800 registered people, ₹2,74,000 net spend.
3. Tasks → change a status. Open Overview in another tab: the execution counts update within a few seconds.
4. Dataset Manager → upload `tests/fixtures/changed-schema.xlsx`, accept the suggested mapping, import and activate. Overview now shows the new dataset with warnings about missing fields. Use "Make active" on the original to switch back.
5. AI Growth Analyst → ask "What is the venue's confirmed daily capacity?" (expect an explanation that it is not configured), then "Create a follow-up task for Arjun to cut Paid Social prospecting spend, due next Friday" (expect an approval card; approve it and find the task in Tasks).
6. Sign in as `dev@demo.fest` / `Demo-Member-2026` and confirm Dataset Manager is read-only and task creation is not offered.

You can also run the scripted checks against the live site:

```bash
BASE_URL=https://<your-app>.vercel.app DATABASE_URL=<pooler URI> npm run test:e2e
```

(This writes a few test records and restores the one campaign it edits.)

## 4. Optional: run the AI evaluation

Point `DATABASE_URL` at a **separate** Supabase project or branch seeded the same way (the suite temporarily changes data), then:

```bash
ANTHROPIC_API_KEY=... npm run eval:ai
```

It writes `docs/ai-evaluation-results.md` with a pass/fail table.

## Resetting the demo

- In the app: Dataset Manager → Restore demo state (re-activates the original dataset and restores default planning assumptions).
- Full rebuild: `npm run db:reset-demo` from a machine with `DATABASE_URL` set. This recreates users, tasks and budgets. The audit log is append-only and is kept.

## Security checklist before real use

- Change or remove the demo accounts and set `SHOW_DEMO_LOGINS=false`.
- Rotate `SESSION_SECRET` if it was ever shared.
- Keep `ANTHROPIC_API_KEY` and `DATABASE_URL` only in Vercel's environment settings; neither is sent to the browser.
