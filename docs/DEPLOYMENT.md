# LogLineOS Deployment Guide

This guide walks you through deploying LogLineOS to Supabase from scratch.

---

## Prerequisites

- ✅ Supabase account ([supabase.com](https://supabase.com))
- ✅ Node.js 18+ installed
- ✅ Supabase CLI installed (`npm install -g supabase`)
- ✅ Git

---

## Step 1: Supabase Project Setup (5 min)

### 1.1 Create Project

1. Go to [supabase.com/dashboard](https://supabase.com/dashboard)
2. Click "New Project"
3. Choose:
   - Name: `loglineos` (or your preference)
   - Database Password: (generate strong password)
   - Region: (closest to you)
4. Wait for provisioning (~2 minutes)

### 1.2 Get Credentials

1. Go to Project Settings → API
2. Copy:
   - **Project URL**: `https://xxxxx.supabase.co`
   - **anon public**: `eyJhbGc...` (for clients)
   - **service_role**: `eyJhbGc...` (⚠️ keep secret!)

### 1.3 Configure Local Environment

```bash
cd loglineos-deploy
cp .env.example .env
```

Edit `.env`:
```env
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...  # ⚠️ Secret!
APP_USER_ID=system
APP_TENANT_ID=system
```

---

## Step 2: Database Schema (5 min)

### 2.1 Run Schema SQL

1. Open [Supabase SQL Editor](https://supabase.com/dashboard/project/_/sql)
2. Click "New Query"
3. Copy entire contents of `sql/01-schema.sql`
4. Paste into editor
5. Click "Run" (▶️)
6. ✅ Should see: "Schema created successfully"

**What this does:**
- Creates `ledger.universal_registry` table
- Enables RLS (Row Level Security)
- Adds append-only trigger
- Adds NOTIFY trigger for real-time
- Creates indexes for performance

### 2.2 Create Initial Manifest

1. In SQL Editor, click "New Query"
2. Copy entire contents of `sql/02-manifest.sql`
3. Paste and "Run"
4. ✅ Should see: "Manifest created successfully"

**What this does:**
- Inserts governance manifest
- Defines kernel whitelist
- Sets throttle limits
- Configures policy thresholds

---

## Step 3: Bootstrap Kernels (2 min)

Run from your local machine:

```bash
npm install
npm run bootstrap:kernels
```

✅ Expected output:
```
🔄 Bootstrapping 5 core kernels...

✅ run_code_kernel created
✅ observer_bot_kernel created
✅ request_worker_kernel created
✅ policy_agent_kernel created
✅ provider_exec_kernel created

✅ All kernels bootstrapped successfully!

📋 Verification:
   Found 5/5 kernels in ledger

🎉 Bootstrap complete! Next steps:
   1. npm run deploy:stage0
   2. npm run deploy:workers
   3. npm run verify
```

**What this does:**
- Inserts 5 core kernel functions into ledger
- All kernels stored as `entity_type='function'` spans
- Each kernel has stable UUID
- Code lives in the ledger (not in files)

---

## Step 4: Deploy Edge Functions (5 min)

### 4.1 Link Supabase Project

```bash
supabase login
supabase link --project-ref <YOUR_PROJECT_REF>
```

To get your project ref:
1. Go to Project Settings → General
2. Copy "Reference ID"

### 4.2 Deploy Stage-0

```bash
npm run deploy:stage0
```

✅ Expected output:
```
Deploying Function stage0...
✓ Function stage0 deployed successfully.
```

### 4.3 Deploy Workers

```bash
npm run deploy:workers
```

This deploys 3 workers:
- `observer` - Monitors scheduled functions
- `request-worker` - Processes execution requests
- `policy-agent` - Evaluates policies

✅ Expected output:
```
Deploying Function observer...
✓ Function observer deployed successfully.

Deploying Function request-worker...
✓ Function request-worker deployed successfully.

Deploying Function policy-agent...
✓ Function policy-agent deployed successfully.
```

---

## Step 5: Configure Cron Jobs (3 min)

Workers need to run periodically. We use `pg_cron` (built into Supabase).

### 5.1 Setup Service Role Key

In SQL Editor:
```sql
-- Store service role key securely
ALTER DATABASE postgres SET app.service_role_key TO 'YOUR_SERVICE_ROLE_KEY';
```

Replace `YOUR_SERVICE_ROLE_KEY` with your actual key from .env.

### 5.2 Schedule Workers

In SQL Editor, run:

```sql
-- Observer Bot (every 10 seconds)
SELECT cron.schedule(
  'observer-bot',
  '*/10 * * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/observer',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

-- Request Worker (every 5 seconds)
SELECT cron.schedule(
  'request-worker',
  '*/5 * * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/request-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 5000
  );
  $$
);

-- Policy Agent (every 30 seconds)
SELECT cron.schedule(
  'policy-agent',
  '*/30 * * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR-PROJECT.supabase.co/functions/v1/policy-agent',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
```

⚠️ **Important:** Replace `YOUR-PROJECT` with your actual Supabase project URL.

### 5.3 Verify Cron Jobs

```sql
SELECT * FROM cron.job;
```

You should see 3 jobs:
- `observer-bot`
- `request-worker`
- `policy-agent`

---

## Step 6: Verify Installation (1 min)

```bash
npm run verify
```

✅ Expected output:
```
🔍 Verifying LogLineOS installation...

✅ Manifest exists
   ID: 00000000-0000-4000-8000-0000000000aa
   Kernels: 5
✅ All 5 kernels found
   - run_code_kernel (active)
   - observer_bot_kernel (active)
   - request_worker_kernel (active)
   - policy_agent_kernel (active)
   - provider_exec_kernel (active)
✅ RLS enabled on universal_registry
✅ Append-only trigger active

==================================================
✅ All checks passed! LogLineOS is ready.

Next steps:
  1. Deploy Edge Functions: npm run deploy:stage0
  2. Deploy Workers: npm run deploy:workers
  3. Test: npm run test:e2e
```

---

## Step 7: Test End-to-End (2 min)

```bash
npm run test:e2e
```

This test:
1. Creates a test function with `status='scheduled'`
2. Waits for observer to detect it (≤15s)
3. Waits for request_worker to execute it (≤15s)
4. Verifies execution was recorded
5. Cleans up

✅ Expected output:
```
🧪 Running end-to-end test...

1️⃣ Creating test function...
   ✅ Test function created: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

2️⃣ Waiting for observer to create request span (max 15s)...
   ✅ Request span created after 8s

3️⃣ Waiting for request_worker to execute (max 15s)...
   ✅ Execution completed after 5s
   Status: complete
   Output: {
     "message": "Hello from E2E test!",
     "timestamp": "2025-11-01T..."
   }

4️⃣ Verifying complete flow...
   Timeline:
   - function (scheduled)
   - request (scheduled)
   - execution (complete)

5️⃣ Cleaning up...
   ✅ Test data marked as deleted

✅ End-to-end test PASSED!

Summary:
  - Function created
  - Observer detected and created request
  - Request worker executed function
  - Execution recorded in ledger

🎉 LogLineOS is working correctly!
```

---

## Monitoring

### View Cron Job Logs

```sql
SELECT 
  jobid,
  jobname,
  status,
  return_message,
  start_time,
  end_time
FROM cron.job_run_details
ORDER BY start_time DESC
LIMIT 20;
```

### View Recent Executions

```sql
SELECT 
  id,
  who,
  status,
  duration_ms,
  at
FROM ledger.visible_timeline
WHERE entity_type = 'execution'
ORDER BY at DESC
LIMIT 10;
```

### View Function Logs

```bash
# Stage-0 logs
supabase functions logs stage0

# Worker logs
supabase functions logs observer
supabase functions logs request-worker
supabase functions logs policy-agent
```

---

## Troubleshooting

### Cron Jobs Not Running

Check if jobs are scheduled:
```sql
SELECT * FROM cron.job WHERE active = true;
```

Check recent failures:
```sql
SELECT * FROM cron.job_run_details 
WHERE status = 'failed' 
ORDER BY start_time DESC 
LIMIT 10;
```

### Workers Not Executing

Test worker manually:
```bash
curl -X POST https://YOUR-PROJECT.supabase.co/functions/v1/observer \
  -H "Authorization: Bearer YOUR_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json"
```

### Functions Not Found

Re-run bootstrap:
```bash
npm run bootstrap:kernels
```

Verify:
```sql
SELECT id, name, status 
FROM ledger.visible_timeline 
WHERE entity_type = 'function';
```

---

## Next Steps

### Enable Cryptographic Signatures

```bash
npm run keys:generate
# Add SIGNING_KEY_HEX to .env
```

Update manifest:
```sql
UPDATE ledger.universal_registry 
SET metadata = jsonb_set(
  metadata, 
  '{features,signatures_required}', 
  'true'
)
WHERE entity_type = 'manifest';
```

### Add Custom Policies

See `Blueprint.md` for policy examples.

### Create Your First Function

```sql
INSERT INTO ledger.universal_registry (
  id, seq, entity_type, who, did, this, at, status,
  name, code, language, runtime,
  owner_id, tenant_id, visibility
) VALUES (
  gen_random_uuid(), 0, 'function', 'user:you', 'defined', 'my_function', now(), 'active',
  'hello_world',
  'return { message: "Hello, LogLineOS!" };',
  'javascript', 'deno@1.x',
  'user:you', 'your-tenant', 'private'
);
```

---

## Production Checklist

Before going to production:

- [ ] Enable cryptographic signatures
- [ ] Configure quotas in manifest
- [ ] Set up monitoring and alerts
- [ ] Configure backup strategy
- [ ] Test disaster recovery
- [ ] Document custom policies
- [ ] Set up CI/CD for kernel updates
- [ ] Review RLS policies
- [ ] Configure rate limiting
- [ ] Set up log retention

---

**🎉 Deployment Complete!**

You now have a fully functional LogLineOS instance running on Supabase.
