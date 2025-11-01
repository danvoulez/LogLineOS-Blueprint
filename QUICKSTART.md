# 🚀 LogLineOS - 5-Minute Quickstart

Get LogLineOS running in **under 10 minutes**.

## Prerequisites

- ✅ Supabase account ([supabase.com](https://supabase.com))
- ✅ Node.js 18+ installed
- ✅ Git

## Step 1: Clone & Install (1 min)

```bash
git clone https://github.com/your-org/loglineos-deploy
cd loglineos-deploy
npm install
```

## Step 2: Configure Supabase (2 min)

### 2.1 Create Supabase Project
1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click "New Project"
3. Note your project URL and keys

### 2.2 Setup Environment
```bash
cp .env.example .env
```

Edit `.env` and add your credentials:
```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...  # ⚠️ Keep this secret!
```

## Step 3: Initialize Database (3 min)

### 3.1 Run Schema
1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql)
2. Copy contents of `sql/01-schema.sql`
3. Paste and click "Run"
4. ✅ Should see: "Schema created successfully"

### 3.2 Create Manifest
1. In SQL Editor, copy contents of `sql/02-manifest.sql`
2. Paste and click "Run"
3. ✅ Should see: "Manifest created successfully"

## Step 4: Bootstrap Kernels (2 min)

```bash
npm run bootstrap:kernels
```

✅ Expected output:
```
Bootstrapping 5 core kernels...
✅ run_code_kernel created
✅ observer_bot_kernel created
✅ request_worker_kernel created
✅ policy_agent_kernel created
✅ provider_exec_kernel created
All kernels bootstrapped successfully!
```

## Step 5: Deploy Functions (2 min)

### 5.1 Install Supabase CLI
```bash
npm install -g supabase
supabase login
```

### 5.2 Link Project
```bash
supabase link --project-ref <YOUR_PROJECT_REF>
```

### 5.3 Deploy
```bash
npm run deploy:stage0
npm run deploy:workers
```

## Step 6: Verify (1 min)

```bash
npm run verify
```

✅ Expected output:
```
🔍 Verifying LogLineOS installation...
✅ Manifest exists
✅ 5 kernels found
✅ RLS policies active
✅ Append-only trigger working
✅ Stage-0 responding
All checks passed! 🎉
```

## Step 7: Test End-to-End (1 min)

```bash
npm run test:e2e
```

✅ Expected: Full execution cycle completes in ~10-15 seconds.

---

## Next Steps

### Setup Cron Jobs
To enable automatic processing, run this in SQL Editor:

```sql
-- Observer (every 10s)
SELECT cron.schedule(
  'observer-bot',
  '*/10 * * * * *',
  $$ SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/observer',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.service_role_key')),
    body := '{}'::jsonb
  ) $$
);
```

(See full cron setup in [docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md))

### Enable Cryptographic Signatures (Optional)
```bash
npm run keys:generate
# Add SIGNING_KEY_HEX to .env
# Update manifest to set signatures_required: true
```

### Explore Documentation
- 📖 [Full Documentation](./docs/)
- 🏗️ [Architecture](./docs/ARCHITECTURE.md)
- 📋 [ADRs](./docs/adr/README.md)

---

## Troubleshooting

### "Manifest not found"
```bash
# Re-run in SQL Editor:
cat sql/02-manifest.sql | pbcopy  # macOS
# Paste in SQL Editor and Run
```

### "Kernels not bootstrapping"
```bash
# Check .env file has correct credentials
npm run verify
npm run bootstrap:kernels
```

### "Functions not deploying"
```bash
# Ensure Supabase CLI is linked
supabase link --project-ref <REF>
supabase functions list
```

---

**You're all set! 🎉**

LogLineOS is now running. Check the [Architecture docs](./docs/ARCHITECTURE.md) to understand how it works.
