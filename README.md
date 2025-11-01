# LogLineOS - Ledger-Only Backend

> Universal, semantic, ledger-only backend for spans, automations, policies, and prompts.

**Status:** Production-Ready  
**Version:** 1.0.0  
**License:** MIT

---

## 🎯 What is LogLineOS?

LogLineOS is a **ledger-first backend** where every behavior (executors, observers, policies, providers) is stored as **versioned spans** in an append-only ledger. The only code outside the ledger is a Stage-0 loader that boots whitelisted functions by ID, verifies signatures/hashes, and executes them.

### Core Principles

1. ✅ **Ledger-First** - All business logic stored as spans
2. ✅ **Append-Only** - No UPDATE or DELETE operations
3. ✅ **Stage-0 Bootstrap** - Immutable loader executes functions from ledger
4. ✅ **RLS Multi-tenant** - owner_id/tenant_id/visibility enforcement
5. ✅ **Span as Primitive** - Functions, executions, policies, metrics = spans
6. ✅ **Manifest Governance** - Whitelist controls what can execute
7. ✅ **Cryptographic Proofs** - Optional BLAKE3 + Ed25519 signatures

---

## 🚀 Quick Start

**Get running in 10 minutes:** See [QUICKSTART.md](./QUICKSTART.md)

```bash
# 1. Clone and install
git clone https://github.com/your-org/loglineos-deploy
cd loglineos-deploy
npm install

# 2. Configure .env with Supabase credentials
cp .env.example .env
# Edit .env

# 3. Initialize database (run SQL files in Supabase SQL Editor)
# - sql/01-schema.sql
# - sql/02-manifest.sql

# 4. Bootstrap kernels
npm run bootstrap:kernels

# 5. Deploy functions
npm run deploy:stage0
npm run deploy:workers

# 6. Verify
npm run verify

# 7. Test
npm run test:e2e
```

---

## 📖 Documentation

### Core Documents
- **[Blueprint.md](./Blueprint.md)** - Complete system specification
- **[ADRs.md](./ADRs.md)** - All architectural decisions with rationale
- **[QUICKSTART.md](./QUICKSTART.md)** - 5-minute setup guide

### Implementation Guides
- **Architecture** - System design and components *(coming soon)*
- **Deployment** - Detailed deployment instructions *(coming soon)*
- **Operations** - Monitoring, alerts, troubleshooting *(coming soon)*
- **Migration** - How to migrate to another provider *(coming soon)*

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│  LEDGER (PostgreSQL)                                    │
│  ┌─────────────────────────────────────────────────┐   │
│  │  Manifest (governance)                          │   │
│  │  - allowed_boot_ids                             │   │
│  │  - quotas, policies                             │   │
│  ├─────────────────────────────────────────────────┤   │
│  │  5 Core Kernels (as spans)                      │   │
│  │  - run_code_kernel                              │   │
│  │  - observer_bot_kernel                          │   │
│  │  - request_worker_kernel                        │   │
│  │  - policy_agent_kernel                          │   │
│  │  - provider_exec_kernel                         │   │
│  ├─────────────────────────────────────────────────┤   │
│  │  User Functions, Policies, Executions           │   │
│  │  (all as spans in universal_registry)           │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
           ▲                           ▲
           │                           │
    ┌──────┴────────┐          ┌──────┴────────┐
    │  Stage-0      │          │  Workers       │
    │  (loads from  │◄─────────│  (delegate to  │
    │   ledger)     │          │   stage-0)     │
    └───────────────┘          └────────────────┘
```

### Key Components

1. **Ledger** - PostgreSQL with universal_registry table (~70 semantic columns)
2. **Stage-0** - Immutable bootstrap loader (Edge Function)
3. **Workers** - Observer, Request Worker, Policy Agent (Edge Functions)
4. **Kernels** - Execution logic stored as spans in the ledger
5. **Manifest** - Governance document controlling allowed operations

---

## 📁 Project Structure

```
loglineos-deploy/
├── README.md                    # This file
├── QUICKSTART.md               # 5-minute guide
├── Blueprint.md                # Complete specification
├── ADRs.md                     # Architectural decisions
├── package.json
├── .env.example
│
├── sql/
│   ├── 01-schema.sql           # Core schema + RLS
│   └── 02-manifest.sql         # Initial manifest
│
├── supabase/
│   └── functions/
│       ├── stage0/             # Bootstrap loader
│       ├── observer/           # Observer worker
│       ├── request-worker/     # Request processor
│       └── policy-agent/       # Policy executor
│
└── scripts/
    ├── bootstrap-kernels.ts    # Insert 5 core kernels
    ├── bootstrap-policies.ts   # Insert base policies
    ├── validate-compliance.ts  # Verify blueprint compliance
    ├── test-e2e.ts            # End-to-end tests
    ├── verify.ts              # Health check
    └── generate-keys.ts       # Ed25519 key generator
```

---

## 🔧 Configuration

### Environment Variables

```bash
# Supabase
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...

# LogLineOS
APP_USER_ID=system
APP_TENANT_ID=system

# Optional: Cryptographic signing
SIGNING_KEY_HEX=

# Environment
NODE_ENV=production
```

### Manifest Configuration

Key settings in the manifest (stored as span in ledger):
- **allowed_boot_ids** - Whitelist of kernels that can execute
- **throttle limits** - Per-tenant daily execution limits
- **policy thresholds** - Slow/timeout thresholds
- **feature flags** - signatures_required, strict_mode, etc.

---

## 🧪 Testing

```bash
# Verify system health
npm run verify

# End-to-end test
npm run test:e2e

# Validate blueprint compliance
npm run validate:compliance
```

### What Gets Tested
- ✅ Manifest exists and is valid
- ✅ All 5 kernels present in ledger
- ✅ RLS policies active
- ✅ Append-only trigger working
- ✅ Stage-0 can load and execute kernels
- ✅ Workers can process requests
- ✅ Full execution flow (10-15s)

---

## 📊 Available Scripts

| Command | Description |
|---------|-------------|
| `npm run deploy:stage0` | Deploy Stage-0 loader |
| `npm run deploy:workers` | Deploy all workers |
| `npm run bootstrap:kernels` | Insert 5 core kernels |
| `npm run bootstrap:policies` | Insert base policies |
| `npm run verify` | Health check |
| `npm run test:e2e` | End-to-end test |
| `npm run validate:compliance` | Verify blueprint compliance |
| `npm run keys:generate` | Generate Ed25519 keys |

---

## 🔐 Security

### Authentication & Authorization
- **RLS (Row Level Security)** - Enforces owner_id/tenant_id/visibility
- **JWT-based auth** - Supabase Auth with custom claims
- **Service role** - Restricted to Stage-0 and workers only

### Cryptographic Proofs
```bash
# Generate Ed25519 keys
npm run keys:generate

# Add to .env
SIGNING_KEY_HEX=<generated_key>

# Update manifest: signatures_required = true
```

---

## 🚢 Deployment

### Supabase (Current)
```bash
npm run setup  # One-time setup
npm run deploy:stage0
npm run deploy:workers
npm run bootstrap:kernels
```

### Other Providers
LogLineOS is **provider-agnostic**. Migrate to:
- **Fly.io** - More control, better performance
- **AWS (ECS + RDS)** - Enterprise compliance
- **Self-hosted** - Docker Compose

**Migration effort:** 2-3 days | **Data portability:** 100%

See ADRs.md for detailed migration strategy.

---

## 🆘 Troubleshooting

### Kernels not found?
```sql
-- Verify in SQL Editor
SELECT id, name, status FROM ledger.visible_timeline 
WHERE entity_type = 'function';

-- If empty, bootstrap again
npm run bootstrap:kernels
```

### Stage-0 not responding?
```bash
# Check logs
supabase functions logs stage0

# Re-deploy
npm run deploy:stage0
```

### Workers not executing?
```bash
# Test manually
curl -X POST https://xxxxx.supabase.co/functions/v1/observer \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY"
```

---

## 🤝 Contributing

### Proposing Changes
1. Check if an ADR exists for the area
2. If making architectural decision, review ADRs.md
3. Validate against blueprint principles:
   - Maintains ledger-first?
   - Maintains append-only?
   - Stage-0 still loads from ledger?
   - RLS still works?
   - Spans still the primitive?
4. Open PR with implementation

---

## 📜 License

MIT License - see LICENSE file for details.

---

## 🎯 Status

| Component | Status | Version |
|-----------|--------|---------|
| **Core Ledger** | ✅ Production | 1.0.0 |
| **Stage-0** | ✅ Production | 1.0.0 |
| **5 Kernels** | ✅ Production | 1.0.0 |
| **Workers** | ✅ Production | 1.0.0 |
| **Bootstrap Scripts** | ✅ Production | 1.0.0 |
| **Testing Suite** | ✅ Production | 1.0.0 |
| **Crypto Proofs** | ✅ Optional (Phase 2) | 1.0.0 |

---

**We trust and build with LogLine.** 🎯

---

## Quick Links

- 📖 [Blueprint](./Blueprint.md) - Complete specification
- 📋 [ADRs](./ADRs.md) - All architectural decisions
- 🚀 [Quickstart](./QUICKSTART.md) - 5-minute setup

---

*Last updated: November 2025*
