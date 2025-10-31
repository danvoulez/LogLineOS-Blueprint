Below is your production‑grade, ledger‑only LogLineOS blueprint — fully consolidated, bilingual, and battle‑hardened.

It reflects our journey (semantic columns → ledger‑only runtime → computeable policies → prompt infrastructure as code), fixes weak spots, and adds missing pieces so teams and LLMs can both consume it with confidence.


---

# **📘 LogLineOS Bluebook (EN/PT)**

Universal, semantic, ledger‑only backend for spans, automations, policies, and prompts.

Postgres \+ Edge runtimes. Frontend‑agnostic. Serverless‑first.

* Core ideals: semantic columns (\~70), append‑only, signed spans, multitenancy, computeable triggers, “code lives in the ledger”.

* Hardening: advisory locks, quotas, slow/timeout policies, compiled prompt hash, circuit breaker, escalation, metrics & SSE.

* LLM‑friendly: JSON Schemas, OpenAPI, NDJSON seeds, stable identifiers, explicit contracts.

---

## **0\) Executive Summary / Resumo Executivo**

EN — LogLineOS is a ledger‑only backend where every behavior (executors, observers, policies, providers, prompt compiler/bandit) is stored as versioned spans (entity\_type='function', seq↑). The only code outside the ledger is a Stage‑0 loader that boots a whitelisted function by ID, verifies signatures/hashes, and executes it. All outputs are signed, append‑only events with traceability.

PT — O LogLineOS é um backend 100% ledger onde todas as regras (executores, observadores, políticas, providers, compilador/bandit de prompt) vivem como spans versionados (entity\_type='function', seq crescente). O único código fora do ledger é o Stage‑0 loader, que inicializa uma função permitida pelo Manifest, verifica assinaturas/hashes e executa. Toda saída é um evento assinado, append‑only e rastreável.

---

## **1\) Schema & RLS (Postgres) / Esquema & RLS (Postgres)**

Note: We keep the “\~70 semantic columns” philosophy, but show a pragmatic core table \+ jsonb for rare fields.  
Obs: Mantemos a filosofia das “\~70 colunas semânticas”, mas mostramos um núcleo prático \+ jsonb para raridades.  
\-- Enable UUIDs and crypto helpers (if needed)  
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

\-- Namespaces  
CREATE SCHEMA IF NOT EXISTS app;  
CREATE SCHEMA IF NOT EXISTS ledger;

\-- Session accessors for RLS  
CREATE OR REPLACE FUNCTION app.current\_user\_id() RETURNS text  
LANGUAGE sql STABLE AS $$ SELECT current\_setting('app.user\_id', true) $$;

CREATE OR REPLACE FUNCTION app.current\_tenant\_id() RETURNS text  
LANGUAGE sql STABLE AS $$ SELECT current\_setting('app.tenant\_id', true) $$;

\-- Universal registry (append-only)  
CREATE TABLE IF NOT EXISTS ledger.universal\_registry (  
  id            uuid        NOT NULL,  
  seq           integer     NOT NULL,  
  entity\_type   text        NOT NULL,   \-- e.g., function, execution, request, policy, provider, metric, prompt\_\*  
  who           text        NOT NULL,  
  did           text,  
  "this"        text        NOT NULL,  
  at            timestamptz NOT NULL DEFAULT now(),

  \-- Relationships  
  parent\_id     uuid,  
  related\_to    uuid\[\],

  \-- Access control  
  owner\_id      text,  
  tenant\_id     text,  
  visibility    text        NOT NULL DEFAULT 'private', \-- private|tenant|public

  \-- Lifecycle  
  status        text,       \-- draft|scheduled|queued|running|complete|error|active|open|pass|fail|slow|...  
  is\_deleted    boolean     NOT NULL DEFAULT false,

  \-- Code & Execution  
  name          text,  
  description   text,  
  code          text,  
  language      text,  
  runtime       text,  
  input         jsonb,  
  output        jsonb,  
  error         jsonb,

  \-- Quantitative/metrics  
  duration\_ms   integer,  
  trace\_id      text,

  \-- Crypto proofs  
  prev\_hash     text,  
  curr\_hash     text,  
  signature     text,  
  public\_key    text,

  \-- Extensibility  
  metadata      jsonb,

  PRIMARY KEY (id, seq),  
  CONSTRAINT ck\_visibility CHECK (visibility IN ('private','tenant','public')),  
  CONSTRAINT ck\_append\_only CHECK (seq \>= 0\)  
);

\-- “Visible timeline” view: legacy alias "when" → "at" for kernels that expect it  
CREATE OR REPLACE VIEW ledger.visible\_timeline AS  
SELECT  
  ur.\*,  
  ur.at AS "when"  
FROM ledger.universal\_registry ur  
WHERE ur.is\_deleted \= false;

\-- Append-only enforcement: disallow UPDATE/DELETE  
CREATE OR REPLACE FUNCTION ledger.no\_updates() RETURNS trigger LANGUAGE plpgsql AS $$  
BEGIN  
  RAISE EXCEPTION 'Append-only table: updates/deletes are not allowed.';  
END; $$;

DO $$  
BEGIN  
  IF NOT EXISTS (  
    SELECT 1 FROM pg\_trigger WHERE tgname \= 'ur\_no\_update'  
  ) THEN  
    CREATE TRIGGER ur\_no\_update BEFORE UPDATE OR DELETE ON ledger.universal\_registry  
    FOR EACH ROW EXECUTE FUNCTION ledger.no\_updates();  
  END IF;  
END $$;

\-- Notify on insert for SSE  
CREATE OR REPLACE FUNCTION ledger.notify\_timeline() RETURNS trigger LANGUAGE plpgsql AS $$  
BEGIN  
  PERFORM pg\_notify('timeline\_updates', row\_to\_json(NEW)::text);  
  RETURN NEW;  
END; $$;

DO $$  
BEGIN  
  IF NOT EXISTS (  
    SELECT 1 FROM pg\_trigger WHERE tgname \= 'ur\_notify\_insert'  
  ) THEN  
    CREATE TRIGGER ur\_notify\_insert AFTER INSERT ON ledger.universal\_registry  
    FOR EACH ROW EXECUTE FUNCTION ledger.notify\_timeline();  
  END IF;  
END $$;

\-- Useful indexes  
CREATE INDEX IF NOT EXISTS ur\_idx\_at ON ledger.universal\_registry (at DESC);  
CREATE INDEX IF NOT EXISTS ur\_idx\_entity ON ledger.universal\_registry (entity\_type, at DESC);  
CREATE INDEX IF NOT EXISTS ur\_idx\_owner\_tenant ON ledger.universal\_registry (owner\_id, tenant\_id);  
CREATE INDEX IF NOT EXISTS ur\_idx\_trace ON ledger.universal\_registry (trace\_id);  
CREATE INDEX IF NOT EXISTS ur\_idx\_parent ON ledger.universal\_registry (parent\_id);  
CREATE INDEX IF NOT EXISTS ur\_idx\_related ON ledger.universal\_registry USING GIN (related\_to);  
CREATE INDEX IF NOT EXISTS ur\_idx\_metadata ON ledger.universal\_registry USING GIN (metadata);

\-- ✅ FIX: Idempotency for observer-generated requests (prevents duplicate scheduling)  
CREATE UNIQUE INDEX IF NOT EXISTS ur\_idx\_request\_idempotent  
  ON ledger.universal\_registry (parent\_id, entity\_type, status)  
  WHERE entity\_type = 'request' AND status = 'scheduled' AND is\_deleted = false;

\-- RLS  
ALTER TABLE ledger.universal\_registry ENABLE ROW LEVEL SECURITY;

\-- SELECT: owner OR same tenant with visibility tenant/public OR visibility public  
CREATE POLICY ur\_select\_policy ON ledger.universal\_registry  
  FOR SELECT USING (  
    (owner\_id IS NOT DISTINCT FROM app.current\_user\_id())  
    OR (visibility \= 'public')  
    OR (tenant\_id IS NOT DISTINCT FROM app.current\_tenant\_id() AND visibility IN ('tenant','public'))  
  );

\-- INSERT: requester must set app.user\_id; row owner\_id \= app.user\_id; tenant matches session if provided  
CREATE POLICY ur\_insert\_policy ON ledger.universal\_registry  
  FOR INSERT WITH CHECK (  
    owner\_id IS NOT DISTINCT FROM app.current\_user\_id()  
    AND (tenant\_id IS NULL OR tenant\_id IS NOT DISTINCT FROM app.current\_tenant\_id())  
  );  
Why “at” \+ “when”?: we store as at (column), expose when via view for kernels that used "when".  
Por que “at” \+ “when”?: gravamos em at e expomos "when" na view para manter compatibilidade.  
---

## **2\) Stage‑0 Loader (Deno/Node) / Carregador Stage‑0 (Deno/Node)**

Immutable bootstrap binary. It fetches a whitelisted function from the Manifest, verifies hash/signature, executes it with a minimal context, and appends a boot\_event.  
Binário imutável. Busca função permitida no Manifest, verifica hash/assinatura, executa com contexto mínimo e registra boot\_event.  
// stage0\_loader.ts — Deno (recommended) or Node 18+ (ESM)  
import pg from "https://esm.sh/pg@8.11.3";  
import { blake3 } from "https://esm.sh/@noble/hashes@1.3.3/blake3";  
import \* as ed from "https://esm.sh/@noble/ed25519@2.1.1";

const { Client } \= pg;  
const hex \= (u8: Uint8Array) \=\> Array.from(u8).map(b=\>b.toString(16).padStart(2,"0")).join("");  
const toU8 \= (h: string) \=\> Uint8Array.from(h.match(/.{1,2}/g)\!.map(x=\>parseInt(x,16)));

const DATABASE\_URL   \= Deno.env.get("DATABASE\_URL")\!;  
const BOOT\_FUNCTION\_ID \= Deno.env.get("BOOT\_FUNCTION\_ID")\!; // must be in manifest.allowed\_boot\_ids  
const APP\_USER\_ID    \= Deno.env.get("APP\_USER\_ID") || "edge:stage0";  
const APP\_TENANT\_ID  \= Deno.env.get("APP\_TENANT\_ID") || null;  
const SIGNING\_KEY\_HEX= Deno.env.get("SIGNING\_KEY\_HEX") || undefined;

async function withPg\<T\>(fn:(c:any)=\>Promise\<T\>):Promise\<T\>{  
  const c \= new Client({ connectionString: DATABASE\_URL }); await c.connect();  
  try {  
    await c.query(\`SET app.user\_id \= $1\`, \[APP\_USER\_ID\]);  
    if (APP\_TENANT\_ID) await c.query(\`SET app.tenant\_id \= $1\`, \[APP\_TENANT\_ID\]);  
    return await fn(c);  
  } finally { await c.end(); }  
}

// A safe, standard SQL tagged template literal factory.  
// This prevents SQL injection by design. Kernels will use this.  
function createSafeSql(client: pg.Client) {  
  return async function sql(strings: TemplateStringsArray, ...values: any\[\]) {  
    const queryText \= strings.reduce((prev, curr, i) \=\> {  
      return prev \+ (i \> 0 ? \`$${i}\` : "") \+ curr;  
    }, "");  
    return client.query(queryText, values);  
  };  
}

async function latestManifest(){  
  const { rows } \= await withPg(c \=\> c.query(  
    \`SELECT \* FROM ledger.visible\_timeline WHERE entity\_type='manifest' ORDER BY "when" DESC LIMIT 1\`));  
  return rows\[0\] || { metadata:{} };  
}

async function verifySpan(span:any){  
  const clone \= structuredClone(span);  
  delete clone.signature; // sign curr\_hash over the canonical payload  
  const msg \= new TextEncoder().encode(JSON.stringify(clone, Object.keys(clone).sort()));  
  const h \= hex(blake3(msg));  
  if (span.curr\_hash && span.curr\_hash \!== h) throw new Error("hash mismatch");  
  if (span.signature && span.public\_key){  
    const ok \= await ed.verify(toU8(span.signature), toU8(h), toU8(span.public\_key));  
    if (\!ok) throw new Error("invalid signature");  
  }  
}

async function fetchLatestFunction(id:string){  
  const { rows } \= await withPg(c=\>c.query(\`  
    SELECT \* FROM ledger.visible\_timeline  
    WHERE id=$1 AND entity\_type='function'  
    ORDER BY "when" DESC, seq DESC LIMIT 1\`, \[id\]));  
  if (\!rows\[0\]) throw new Error("function span not found");  
  return rows\[0\];  
}

async function insertSpan(span:any){  
  await withPg(async c=\>{  
    const cols \= Object.keys(span), vals \= Object.values(span);  
    const placeholders \= cols.map((\_,i)=\>\`$${i+1}\`).join(",");  
    await c.query(\`INSERT INTO ledger.universal\_registry (${cols.map(x=\>\`"${x}"\`).join(",")})  
                   VALUES (${placeholders})\`, vals);  
  });  
}

function now(){ return new Date().toISOString(); }

async function run(){  
  const manifest \= await latestManifest();  
  const allow \= (manifest.metadata?.allowed\_boot\_ids||\[\]) as string\[\];  
  if (\!allow.includes(BOOT\_FUNCTION\_ID)) throw new Error("BOOT\_FUNCTION\_ID not allowed by manifest");

  const fnSpan \= await fetchLatestFunction(BOOT\_FUNCTION\_ID);  
  await verifySpan(fnSpan);

  // Boot event (audit)  
  await insertSpan({  
    id: crypto.randomUUID(), seq:0, entity\_type:'boot\_event',  
    who:'edge:stage0', did:'booted', this:'stage0',  
    at: now(), status:'complete',  
    input:{ boot\_id: BOOT\_FUNCTION\_ID, env: { user: APP\_USER\_ID, tenant: APP\_TENANT\_ID } },  
    owner\_id: fnSpan.owner\_id, tenant\_id: fnSpan.tenant\_id, visibility: fnSpan.visibility ?? 'private',  
    related\_to:\[BOOT\_FUNCTION\_ID\]  
  });

  // Execute function code  
  const factory \= new Function("ctx", \`"use strict";\\n${String(fnSpan.code||"")}\\n;return (typeof default\!=='undefined'?default:globalThis.main);\`);  
  
  // ✅ HARDENED: Provide a secure DB access pattern to kernels.  
  const ctx \= {  
    env: { APP\_USER\_ID, APP\_TENANT\_ID, SIGNING\_KEY\_HEX },  
    // The \`withDb\` function ensures a properly managed connection  
    // and provides a safe \`sql\` tagged template literal function.  
    withDb: async \<T\>(fn: (db: { sql: ReturnType\<typeof createSafeSql\> }) \=\> Promise\<T\>): Promise\<T\> \=\> {  
      return withPg(async (client) \=\> {  
        const sql \= createSafeSql(client);  
        return fn({ sql });  
      });  
    },  
    // Legacy \`sql\` for backward compatibility - redirects to safe implementation  
    sql: (strings:TemplateStringsArray, ...vals:any\[\]) \=\>  
      withPg(async (client) \=\> {  
        const sql \= createSafeSql(client);  
        return sql(strings, ...vals);  
      }),  
    insertSpan,  
    now,  
    crypto: { blake3, ed25519: ed, hex, toU8, randomUUID: crypto.randomUUID }  
  };  
  const main:any \= factory(ctx);  
  if (typeof main \!== "function") throw new Error("kernel has no default/main export");  
  await main(ctx);  
}

if (import.meta.main) run().catch(e=\>{ console.error(e); Deno.exit(1); });  
Recommendation: Run Stage‑0 on Deno / Cloud Run / Fly.io (Workers may restrict creating Web Workers).  
Recomendação: Execute o Stage‑0 em Deno / Cloud Run / Fly.io (alguns providers edge proíbem Worker).  
---

## 3. Kernel Suite (Ledger-Only Architecture)

**Purpose:** This section defines the five core execution kernels that constitute the LogLineOS runtime. All kernels are stored as versioned spans within the ledger itself, loaded and executed by the Stage-0 bootstrap loader.

**Governance:** All kernel IDs are immutable. Version upgrades are performed by creating new seq values while preserving the original ID.

**Nota (PT):** Todos os IDs de kernel são estáveis. Atualizações são realizadas criando novo seq mantendo o mesmo ID.

---

### 3.1 run_code_kernel

**Kernel ID:** `00000000-0000-4000-8000-000000000001`  
**Current Version:** seq=2  
**Invocation:** Triggered by request spans with entity_type='request', status='scheduled'

**Core Functions:**
- Advisory lock per span.id for concurrency control
- Timeout enforcement (configurable via manifest)
- Whitelist validation via Manifest governance
- Quota checking with race condition prevention (tenant-level locks)
- Execution result capture with provenance signatures

* Tenant/visibility checks

* Throttle via Manifest

* Slow threshold via Manifest (policy.slow\_ms, default 5000\)

* Emits signed execution

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,code,language,runtime,owner\_id,tenant\_id,visibility)  
VALUES  
('00000000-0000-4000-8000-000000000001',2,'function','daniel','defined','function',now(),'active',  
'run\_code\_kernel', $$  
globalThis.default \= async function main(ctx){  
  const { sql, insertSpan, now, crypto, env } \= ctx;

  async function latestManifest(){  
    const { rows } \= await sql\`SELECT \* FROM ledger.visible\_timeline WHERE entity\_type='manifest' ORDER BY "when" DESC LIMIT 1\`;  
    return rows\[0\] || { metadata:{} };  
  }  
  async function sign(span){  
    const clone \= structuredClone(span); delete clone.signature; delete clone.curr\_hash;  
    const msg \= new TextEncoder().encode(JSON.stringify(clone, Object.keys(clone).sort()));  
    const h \= crypto.hex(crypto.blake3(msg)); span.curr\_hash \= h;  
    if (env.SIGNING\_KEY\_HEX){  
      const priv \= crypto.toU8(env.SIGNING\_KEY\_HEX);  
      const pub \= await crypto.ed25519.getPublicKey(priv);  
      span.signature \= crypto.hex(await crypto.ed25519.sign(crypto.toU8(h), priv));  
      span.public\_key \= crypto.hex(pub);  
    }  
  }  
  async function tryLock(id){ const r \= await sql\`SELECT pg\_try\_advisory\_lock(hashtext(${id}::text)) ok\`; return \!\!r.rows?.\[0\]?.ok; }  
  async function unlock(id){ await sql\`SELECT pg\_advisory\_unlock(hashtext(${id}::text))\`; }

  const SPAN\_ID \= globalThis.SPAN\_ID || Deno?.env?.get?.("SPAN\_ID");  
  if (\!SPAN\_ID) throw new Error("SPAN\_ID required");  
  if (\!env.APP\_USER\_ID) throw new Error("APP\_USER\_ID required");

  const manifest \= await latestManifest();  
  const throttleLimit \= Number(manifest.metadata?.throttle?.per\_tenant\_daily\_exec\_limit || 100);  
  const slowMs \= Number(manifest.metadata?.policy?.slow\_ms || 5000);  
  const allowed \= (manifest.metadata?.allowed\_boot\_ids||\[\]) as string\[\];  
  if (\!allowed.includes(manifest.metadata?.kernels?.run\_code)) throw new Error("run\_code not allowed by manifest");

  const { rows: fnRows } \= await sql\`SELECT \* FROM ledger.visible\_timeline WHERE id=${SPAN\_ID} ORDER BY "when" DESC, seq DESC LIMIT 1\`;  
  const fnSpan \= fnRows\[0\]; if (\!fnSpan) throw new Error("target function not found");  
  if (fnSpan.entity\_type \!== 'function') throw new Error("run\_code only executes entity\_type=function");  
  if (env.APP\_TENANT\_ID && String(fnSpan.tenant\_id) \!== String(env.APP\_TENANT\_ID)) throw new Error("tenant mismatch");

  // ✅ FIX: Tenant-level lock prevents throttle race condition  
  const tenantLockKey \= \`throttle:${fnSpan.tenant\_id}\`;  
  const tenantLocked \= await tryLock(tenantLockKey);  
  if (\!tenantLocked) { await new Promise(r=\>setTimeout(r,100)); return; } // Retry later  
  
  try {  
    const { rows: usedR } \= await sql\`  
      SELECT count(\*)::int c FROM ledger.visible\_timeline  
      WHERE entity\_type='execution' AND tenant\_id IS NOT DISTINCT FROM ${fnSpan.tenant\_id} AND "when"::date \= now()::date\`;  
    const used \= usedR\[0\]?.c || 0;  
    if (used \>= throttleLimit && \!((fnSpan.metadata?.force) && fnSpan.public\_key && fnSpan.public\_key.toLowerCase() \=== (manifest.metadata?.override\_pubkey\_hex||'').toLowerCase())){  
      await insertSpan({  
        id: crypto.randomUUID(), seq:0, entity\_type:'policy\_violation',  
        who:'edge:run\_code', did:'blocked', this:'quota.exec.per\_tenant.daily',  
        at: now(), status:'error',  
        owner\_id: fnSpan.owner\_id, tenant\_id: fnSpan.tenant\_id, visibility: fnSpan.visibility ?? 'private',  
        related\_to:\[fnSpan.id\],  
        metadata:{ limit: throttleLimit, today: used }  
      });  
      await unlock(tenantLockKey); // ✅ Release tenant lock before returning  
      return;  
    }  
  } finally {  
    await unlock(tenantLockKey); // ✅ Always release tenant lock  
  }

  if (\!(await tryLock(fnSpan.id))) return;  
  const timeoutMs \= slowMs; // align timeout and slow threshold by default  
  const start \= performance.now();  
  let output=null, error=null, trace \= fnSpan.trace\_id || crypto.randomUUID();

  function execSandbox(code, input){  
    // Deno/Browser: Blob Worker; Node: not required in our default path (recommend Deno)  
    const workerCode \= \`  
      self.onmessage \= async (e)=\>{  
        const { code, input } \= e.data;  
        let fn; try { fn \= new Function('input', code); }  
        catch (err){ self.postMessage({e:'compile', d:String(err)}); return; }  
        try { const r \= await fn(input); self.postMessage({ok:true, r}); }  
        catch (err){ self.postMessage({e:'runtime', d:String(err)}); }  
      };  
    \`;  
    const blob \= new Blob(\[workerCode\], { type: "text/javascript" });  
    const url \= URL.createObjectURL(blob);  
    const w \= new Worker(url, { type:"module" });  
    return new Promise((resolve,reject)=\>{  
      const cleanup \= () \=\> { try{w.terminate();}catch{}; try{URL.revokeObjectURL(url);}catch{} }; // ✅ FIX: Revoke blob URL  
      const to \= setTimeout(()=\>{ cleanup(); reject(new Error('timeout')); }, timeoutMs);  
      w.onmessage \= (e)=\>{ clearTimeout(to); cleanup(); const d=e.data; if (d?.ok) resolve(d.r); else reject(new Error(\`${d?.e}:${d?.d}\`)); };  
      w.onerror \= (e)=\>{ clearTimeout(to); cleanup(); reject(e.error ?? new Error('worker\_error')); };  
      w.postMessage({ code, input });  
    });  
  }

  try { output \= await execSandbox(String(fnSpan.code||''), fnSpan.input ?? null); }  
  catch (e){ error \= { message:String(e) }; }  
  finally {  
    const dur \= Math.round(performance.now()-start);  
    const execSpan \= {  
      id: crypto.randomUUID(), seq:0, parent\_id: fnSpan.id, entity\_type:'execution',  
      who:'edge:run\_code', did:'executed', this:'run\_code',  
      at: now(), status: error? 'error' : 'complete',  
      input: fnSpan.input ?? null, output: error? null: output, error,  
      duration\_ms: dur, trace\_id: trace,  
      owner\_id: fnSpan.owner\_id, tenant\_id: fnSpan.tenant\_id, visibility: fnSpan.visibility ?? 'private',  
      related\_to:\[fnSpan.id\]  
    };  
    if (\!error && dur \> slowMs) {  
      execSpan.status \= 'complete'; // keep result  
      // add a status patch marking 'slow' (policy also adds it, this is immediate mark)  
      await insertSpan({  
        id: crypto.randomUUID(), seq:0, entity\_type:'status\_patch',  
        who:'edge:run\_code', did:'labeled', this:'status=slow',  
        at: now(), status:'complete',  
        parent\_id: execSpan.id, related\_to:\[execSpan.id\],  
        owner\_id: fnSpan.owner\_id, tenant\_id: fnSpan.tenant\_id, visibility: fnSpan.visibility ?? 'private',  
        metadata:{ status:'slow', duration\_ms: dur }  
      });  
    }  
    await sign(execSpan);  
    await insertSpan(execSpan);  
    await unlock(fnSpan.id);  
  }  
};  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');

---

### 3.2 observer_bot_kernel

**Kernel ID:** `00000000-0000-4000-8000-000000000002`  
**Current Version:** seq=2  
**Invocation:** Periodic execution via cron or timeline polling

**Core Functions:**
- Monitor ledger for specific entity types or status transitions
- Emit request spans to schedule downstream function executions
- Idempotency enforcement via unique index (prevents duplicate scheduling)
- Advisory locking to prevent concurrent observer race conditions

**Implementation:**

INSERT INTO ledger.universal_registry  
(id,seq,entity_type,who,did,"this",at,status,name,code,language,runtime,owner_id,tenant_id,visibility)  
VALUES  
('00000000-0000-4000-8000-000000000002',2,'function','daniel','defined','function',now(),'active',  
'observer_bot_kernel', $$  
globalThis.default = async function main(ctx){  
  const { sql, now } = ctx;

  async function tryLock(id){ const r \= await sql\`SELECT pg\_try\_advisory\_lock(hashtext(${id}::text)) ok\`; return \!\!r.rows?.\[0\]?.ok; }  
  async function unlock(id){ await sql\`SELECT pg\_advisory\_unlock(hashtext(${id}::text))\`; }  
  async function limitForTenant(tid){  
    const { rows } \= await sql\`SELECT (metadata-\>'throttle'-\>\>'per\_tenant\_daily\_exec\_limit')::int lim  
      FROM ledger.visible\_timeline WHERE entity\_type='manifest' ORDER BY "when" DESC LIMIT 1\`;  
    return rows\[0\]?.lim ?? 100;  
  }  
  async function todayExecs(tid){  
    const { rows } \= await sql\`SELECT count(\*)::int c FROM ledger.visible\_timeline  
      WHERE entity\_type='execution' AND tenant\_id IS NOT DISTINCT FROM ${tid} AND "when"::date=now()::date\`;  
    return rows\[0\]?.c || 0;  
  }

  const { rows } \= await sql\`  
    SELECT id, owner\_id, tenant\_id, visibility  
    FROM ledger.visible\_timeline  
    WHERE entity\_type='function' AND status='scheduled'  
    ORDER BY "when" ASC LIMIT 16\`;

  for (const s of rows){  
    if (\!(await tryLock(s.id))) continue;  
    try {  
      const lim \= await limitForTenant(s.tenant\_id);  
      const used \= await todayExecs(s.tenant\_id);  
      if (used \>= lim) {  
        await sql\`  
          INSERT INTO ledger.universal\_registry  
          (id,seq,who,did,"this",at,entity\_type,status,parent\_id,related\_to,owner\_id,tenant\_id,visibility,metadata)  
          VALUES  
          (gen\_random\_uuid(),0,'edge:observer','blocked','quota.exec.per\_tenant.daily',${now()},'policy\_violation','error',  
           ${s.id}, ARRAY\[${s.id}\]::uuid\[\], ${s.owner\_id}, ${s.tenant\_id}, ${s.visibility}, jsonb\_build\_object('limit',${lim},'today',${used}))\`;  
        continue;  
      }

      \-- idempotent by unique index (parent\_id \+ minute) if you add it  
      await sql\`  
        INSERT INTO ledger.universal\_registry  
        (id,seq,who,did,"this",at,entity\_type,status,parent\_id,related\_to,owner\_id,tenant\_id,visibility,trace\_id)  
        VALUES  
        (gen_random_uuid(),0,'edge:observer','scheduled','run_code',${now()},'request','scheduled',  
         ${s.id}, ARRAY[${s.id}]::uuid[], ${s.owner_id}, ${s.tenant_id}, ${s.visibility}, gen_random_uuid()::text)  
        ON CONFLICT DO NOTHING`;  
    } finally { await unlock(s.id); }  
  }  
};  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');

---

### 3.3 request_worker_kernel

**Kernel ID:** `00000000-0000-4000-8000-000000000003`  
**Current Version:** seq=2  
**Invocation:** Periodic polling for scheduled request spans

**Core Functions:**
- Process request spans with status='scheduled' in FIFO order
- Load and execute target function kernel (typically run_code_kernel)
- Advisory locking on parent_id to prevent duplicate processing
- Batch processing (configurable limit, default: 8 requests per invocation)

**Implementation:**

INSERT INTO ledger.universal_registry  
(id,seq,entity_type,who,did,"this",at,status,name,code,language,runtime,owner_id,tenant_id,visibility)  
VALUES  
('00000000-0000-4000-8000-000000000003',2,'function','daniel','defined','function',now(),'active',  
'request\_worker\_kernel', $$  
globalThis.default \= async function main(ctx){  
  const { sql } \= ctx;  
  const RUN\_CODE\_KERNEL\_ID \= globalThis.RUN\_CODE\_KERNEL\_ID || Deno?.env?.get?.("RUN\_CODE\_KERNEL\_ID") || "00000000-0000-4000-8000-000000000001";

  async function latestKernel(id){  
    const { rows } \= await sql\`SELECT \* FROM ledger.visible\_timeline WHERE id=${id} AND entity\_type='function' ORDER BY "when" DESC, seq DESC LIMIT 1\`;  
    return rows\[0\] || null;  
  }  
  async function tryLock(id){ const r \= await sql\`SELECT pg\_try\_advisory\_lock(hashtext(${id}::text)) ok\`; return \!\!r.rows?.\[0\]?.ok; }  
  async function unlock(id){ await sql\`SELECT pg\_advisory\_unlock(hashtext(${id}::text))\`; }

  const { rows: reqs } \= await sql\`  
    SELECT id, parent\_id FROM ledger.visible\_timeline  
    WHERE entity\_type='request' AND status='scheduled'  
    ORDER BY "when" ASC LIMIT 8\`;  
  if (\!reqs.length) return;

  const runKernel \= await latestKernel(RUN\_CODE\_KERNEL\_ID);  
  if (\!runKernel?.code) throw new Error("run\_code\_kernel not found");

  for (const r of reqs){  
    if (\!(await tryLock(r.parent\_id))) continue;  
    try {  
      globalThis.SPAN\_ID \= r.parent\_id;  
      const factory \= new Function("ctx", \`"use strict";\\n${String(runKernel.code)}\\n;return (typeof default\!=='undefined'?default:globalThis.main);\`);  
      const main = factory(ctx); if (typeof main !== "function") throw new Error("run_code module invalid");  
      await main(ctx);  
    } finally { await unlock(r.parent_id); }  
  }  
};  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');

---

### 3.4 policy_agent_kernel

**Kernel ID:** `00000000-0000-4000-8000-000000000004`  
**Current Version:** seq=1  
**Invocation:** Triggered on new timeline events matching policy predicates

**Core Functions:**
- Execute policy spans (entity_type='policy') against qualifying timeline events
- Sandboxed evaluation via Web Worker isolation (3-second timeout)
- Emit action spans based on policy evaluation results (request, status_patch, metric, etc.)
- Error observability via policy_error spans (audit trail for failed policies)

**Security Model:**
- Policies run in isolated Web Worker context
- No access to parent process memory or filesystem
- Automatic termination on timeout or evaluation error
- Blob URL lifecycle management to prevent memory leaks

**Implementation:**

INSERT INTO ledger.universal_registry  
(id,seq,entity_type,who,did,"this",at,status,name,code,language,runtime,owner_id,tenant_id,visibility)  
VALUES  
('00000000-0000-4000-8000-000000000004',1,'function','daniel','defined','function',now(),'active',  
'policy\_agent\_kernel', $$  
globalThis.default \= async function main(ctx){  
  const { sql, insertSpan, now, crypto } \= ctx;

  function sandboxEval(code, span){  
    const wcode \= \`  
      self.onmessage \= (e)=\>{  
        const { code, span } \= e.data;  
        try {  
          const fn \= new Function('span', code \+ '\\\\n;return (typeof default\!=="undefined"?default:on)||on;')();  
          const out \= fn? fn(span):\[\];  
          self.postMessage({ ok:true, actions: out||\[\] });  
        } catch (err){ self.postMessage({ ok:false, error:String(err) }); }  
      };  
    \`;  
    const blob \= new Blob(\[wcode\], { type:"text/javascript" });  
    const url \= URL.createObjectURL(blob);  
    const w \= new Worker(url, { type:"module" });  
    return new Promise((resolve,reject)=\>{  
      const to \= setTimeout(()=\>{ try{w.terminate();}catch{}; reject(new Error("timeout")); }, 3000);  
      w.onmessage \= (e)=\>{ clearTimeout(to); try{w.terminate();}catch{}; const d=e.data; d?.ok? resolve(d.actions): reject(new Error(d?.error||"policy error")); };  
      w.onerror \= (e)=\>{ clearTimeout(to); try{w.terminate();}catch{}; reject(e.error??new Error("worker error")); };  
      w.postMessage({ code, span });  
    });  
  }  
  async function sign(span){  
    const clone \= structuredClone(span); delete clone.signature; delete clone.curr\_hash;  
    const msg \= new TextEncoder().encode(JSON.stringify(clone, Object.keys(clone).sort()));  
    const h \= crypto.hex(crypto.blake3(msg)); span.curr\_hash \= h;  
  }  
  async function latestCursor(policyId){  
    const { rows } \= await sql\`SELECT max("when") AS at FROM ledger.visible\_timeline WHERE entity\_type='policy\_cursor' AND related\_to @\> ARRAY\[${policyId}\]::uuid\[\]\`;  
    return rows\[0\]?.at || null;  
  }

  const { rows: policies } \= await sql\`  
    SELECT \* FROM ledger.visible\_timeline WHERE entity\_type='policy' AND status='active' ORDER BY "when" ASC\`;

  for (const p of policies){  
    const since \= await latestCursor(p.id);  
    const { rows: candidates } \= await sql\`  
      SELECT \* FROM ledger.visible\_timeline  
      WHERE "when" \> COALESCE(${since}, to\_timestamp(0))  
        AND tenant\_id IS NOT DISTINCT FROM ${p.tenant\_id}  
      ORDER BY "when" ASC LIMIT 500\`;  
    let lastAt \= since;  
    for (const s of candidates){  
      // ✅ FIX: Capture policy errors for observability  
      const actions \= await sandboxEval(String(p.code||""), s).catch(async (err)=\>{  
        await insertSpan({  
          id: crypto.randomUUID(), seq:0, entity\_type:'policy\_error',  
          who:'edge:policy\_agent', did:'failed', this:'policy.eval',  
          at: now(), status:'error',  
          error: { message: String(err), policy\_id: p.id, target\_span: s.id },  
          owner\_id:p.owner\_id, tenant\_id:p.tenant\_id, visibility:p.visibility||'private',  
          related\_to:\[p.id, s.id\]  
        });  
        return \[\]; // Continue with empty actions  
      });  
      for (const a of actions){  
        if (a?.run \=== "run\_code" && a?.span\_id){  
          const req \= {  
            id: crypto.randomUUID(), seq:0, entity\_type:'request', who:'edge:policy\_agent', did:'triggered', this:'run\_code',  
            at: now(), status:'scheduled', parent\_id: a.span\_id, related\_to:\[p.id, a.span\_id\],  
            owner\_id:p.owner\_id, tenant\_id:p.tenant\_id, visibility:p.visibility||'private',  
            metadata: { policy\_id: p.id, trigger\_span: s.id }  
          };  
          await sign(req); await insertSpan(req);  
        } else if (a?.emit\_span){  
          const e \= a.emit\_span;  
          e.id ||= crypto.randomUUID(); e.seq ??= 0; e.at ||= now();  
          e.owner\_id ??= p.owner\_id; e.tenant\_id ??= p.tenant\_id; e.visibility ??= p.visibility||'private';  
          await sign(e); await insertSpan(e);  
        }  
      }  
      lastAt \= s\["when"\] || lastAt;  
    }  
    if (lastAt){  
      const cursor \= {  
        id: crypto.randomUUID(), seq:0, entity\_type:'policy\_cursor', who:'edge:policy\_agent', did:'advanced', this:'cursor',  
        at: now(), status:'complete', related\_to:\[p.id\],  
        owner\_id:p.owner\_id, tenant\_id:p.tenant\_id, visibility:p.visibility||'private',  
        metadata:{ last_at:lastAt }  
      };  
      await sign(cursor); await insertSpan(cursor);  
    }  
  }  
};  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');

---

### 3.5 provider_exec_kernel

**Kernel ID:** `00000000-0000-4000-8000-000000000005`  
**Current Version:** seq=1  
**Invocation:** Triggered by provider_request spans

**Core Functions:**
- Execute external provider calls (OpenAI HTTP API, local Ollama instances)
- Emit provider_execution spans with raw API responses
- Support multiple provider types via configuration
- Handle authentication, rate limiting, and error propagation

**Supported Providers:**
- **OpenAI**: GPT-4, GPT-3.5, embeddings (via HTTPS API)
- **Ollama**: Local model execution (via localhost HTTP)
- **Extensible**: New providers added via configuration spans

**Implementation:**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,code,language,runtime,owner\_id,tenant\_id,visibility)  
VALUES  
('00000000-0000-4000-8000-000000000005',1,'function','daniel','defined','function',now(),'active',  
'provider\_exec\_kernel', $$  
globalThis.default \= async function main(ctx){  
  const { sql, insertSpan, now, crypto, env } \= ctx;

  async function loadProvider(id){  
    const { rows } \= await sql\`SELECT \* FROM ledger.visible\_timeline WHERE id=${id} AND entity\_type='provider' ORDER BY "when" DESC, seq DESC LIMIT 1\`;  
    return rows\[0\] || null;  
  }  
  async function sign(span){  
    const clone \= structuredClone(span); delete clone.signature; delete clone.curr\_hash;  
    const msg \= new TextEncoder().encode(JSON.stringify(clone, Object.keys(clone).sort()));  
    const h \= crypto.hex(crypto.blake3(msg)); span.curr\_hash \= h;  
  }

  const PROVIDER\_ID \= globalThis.PROVIDER\_ID || Deno?.env?.get?.("PROVIDER\_ID");  
  const PAYLOAD \= JSON.parse(globalThis.PROVIDER\_PAYLOAD || Deno?.env?.get?.("PROVIDER\_PAYLOAD") || "{}");  
  const prov \= await loadProvider(PROVIDER\_ID);  
  if (\!prov) throw new Error("provider not found");

  const meta \= prov.metadata || {};  
  let out=null, error=null;

  try {  
    if (meta.base\_url?.includes("openai.com")) {  
      const r \= await fetch(\`${meta.base\_url}/chat/completions\`, {  
        method: "POST",  
        headers: { "content-type":"application/json", "authorization": \`Bearer ${Deno?.env?.get?.(meta.auth\_env) || ""}\` },  
        body: JSON.stringify({ model: meta.model, messages: PAYLOAD.messages, temperature: PAYLOAD.temperature ?? 0.2 })  
      });  
      out \= await r.json();  
    } else if ((meta.base\_url||"").includes("localhost:11434")) {  
      const r \= await fetch(\`${meta.base\_url}/api/chat\`, {  
        method: "POST", headers: { "content-type":"application/json" },  
        body: JSON.stringify({ model: meta.model || "llama3", messages: PAYLOAD.messages })  
      });  
      out \= await r.json();  
    } else { throw new Error("unsupported provider"); }  
  } catch(e){ error \= { message: String(e) }; }

  const execSpan \= {  
    id: crypto.randomUUID(), seq:0, entity\_type:'provider\_execution',  
    who:'edge:provider\_exec', did:'called', this:'provider.exec',  
    at: now(), status: error? 'error':'complete',  
    input: PAYLOAD, output: error? null: out, error,  
    owner\_id: prov.owner\_id, tenant\_id: prov.tenant\_id, visibility: prov.visibility ?? 'private',  
    related\_to: \[prov.id\]  
  };  
  await sign(execSpan); await insertSpan(execSpan);  
};  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');  
---

## **4\) Prompt System Kernels / Kernels do Sistema de Prompts**

### **4.1 Build (ID** 

### **c0c0c0c0-0000-4000-8000-bldp00000001**

### **, seq=1) —** 

### **compiled\_hash**

(Already provided in our “Patch Pack v1” — kept here for consolidation.)

(Code omitted here for brevity — see earlier section “Build kernel ➜ emit compiled\_hash”.)

### **4.2 Prompt Runner (ID** 

### **c0c0c0c0-0000-4000-8000-runp00000001**

### **, seq=1) —** 

### **telemetry (model \+ hash)**

(Code omitted here — see earlier section “Telemetry in prompt\_runner\_kernel”.)

### **4.3 Evaluator (ID** 

### **c0c0c0c0-0000-4000-8000-eval00000001**

### **, seq=1) —** 

### **stress fixtures**

(Code omitted here — see earlier section “Eval kernel understands stress fixtures”.)

### **4.4 Bandit (ID** 

### **c0c0c0c0-0000-4000-8000-band00000001**

### **, seq=0)**

(Code provided earlier — “prompt\_bandit\_kernel”.)

---

## **5\) Policies (ledger‑only) / Políticas (100% ledger)**

* slow\_exec\_policy (status patch slow by threshold)

* metrics\_exec\_duration\_policy (metric per execution)

* daily\_exec\_rollup\_policy (daily counts per owner/status)

* error\_report\_policy (opens error report on execution.error)

* throttle\_policy (labels)

* prompt\_circuit\_breaker\_policy (injects anti‑tool spam block)

* prompt\_confidence\_escalation\_policy (low confidence → human review)

* ttl\_reaper\_policy (NEW: expires temporary blocks by TTL)

SQL for each was given in previous messages. Here is only the new TTL reaper to close a gap.  
INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,code,language,runtime,owner\_id,tenant\_id,visibility)  
VALUES  
('00000000-0000-4000-8000-ppol00000003',0,'policy','daniel','defined','policy',now(),'active',  
'ttl\_reaper\_policy', $$  
export default function on(span){  
  // expire prompt\_block with metadata.ttl\_minutes elapsed  
  if (span.entity\_type\!=='prompt\_block') return \[\];  
  const ttl \= Number(span.metadata?.ttl\_minutes||0);  
  if (\!ttl) return \[\];  
  const created \= new Date(span\["when"\]||span.at||Date.now());  
  const expired \= (Date.now() \- created.getTime()) \> (ttl\*60\*1000);  
  if (\!expired) return \[\];  
  return \[{  
    emit\_span: {  
      entity\_type:'status\_patch', who:'policy:ttl', did:'expired', this:'status=archived',  
      status:'complete', parent\_id: span.id, related\_to:\[span.id\],  
      metadata:{ reason:'ttl' }  
    }  
  }\];  
}  
$$,'javascript','deno@1.x','daniel','voulezvous','tenant');  
---

## **6\) Manifest & Governance / Manifesto & Governança**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('00000000-0000-4000-8000-0000000000aa',2,'manifest','daniel','defined','manifest',now(),'active',  
'kernel\_manifest',  
jsonb\_build\_object(  
  'kernels', jsonb\_build\_object(  
    'run\_code','00000000-0000-4000-8000-000000000001',  
    'observer','00000000-0000-4000-8000-000000000002',  
    'request\_worker','00000000-0000-4000-8000-000000000003',  
    'policy\_agent','00000000-0000-4000-8000-000000000004',  
    'provider\_exec','00000000-0000-4000-8000-000000000005',  
    'stage0\_loader','00000000-0000-4000-8000-0000000000ff'  
  ),  
  'allowed\_boot\_ids', jsonb\_build\_array(  
    '00000000-0000-4000-8000-000000000001',  
    '00000000-0000-4000-8000-000000000002',  
    '00000000-0000-4000-8000-000000000003',  
    '00000000-0000-4000-8000-000000000004',  
    '00000000-0000-4000-8000-000000000005',  
    '00000000-0000-4000-8000-0000000000ff'  
  ),  
  'throttle', jsonb\_build\_object('per\_tenant\_daily\_exec\_limit', 100),  
  'policy', jsonb\_build\_object('slow\_ms', 5000),  
  'override\_pubkey\_hex', 'PUT\_YOUR\_ADMIN\_PUBKEY\_HEX\_HERE'  
),  
'daniel','voulezvous','tenant');  
---

## **7\) API Layer (Edge) / Camada de API (Edge)**

### **7.1 Minimal Deno HTTP (REST \+ SSE) / Deno HTTP mínimo (REST \+ SSE)**

Tip: Use this as a stand‑alone or behind Vercel/CF proxy.  
Dica: Pode rodar sozinho ou atrás de Vercel/Cloudflare.  
// api/index.ts — Deno deploy/Cloud Run/Fly  
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";  
import pg from "https://esm.sh/pg@8.11.3";  
const { Client } \= pg;

const DATABASE\_URL \= Deno.env.get("DATABASE\_URL")\!;

serve(async (req) \=\> {  
  const url \= new URL(req.url);  
  // CORS  
  if (req.method \=== "OPTIONS") return new Response(null, { headers: cors() });

  try {  
    if (url.pathname \=== "/api/spans" && req.method \=== "GET") return listSpans(req);  
    if (url.pathname \=== "/api/spans" && req.method \=== "POST") return createSpan(req);  
    if (url.pathname \=== "/api/timeline" && req.method \=== "GET") return timeline(req);  
    if (url.pathname \=== "/api/execute" && req.method \=== "POST") return executeNow(req);  
    if (url.pathname \=== "/api/metrics" && req.method \=== "GET") return metrics();  
    if (url.pathname \=== "/api/timeline/stream" && req.method \=== "GET") return streamTimeline(req);  
    return new Response("Not Found", { status: 404, headers: corsJson() });  
  } catch (e) {  
    return new Response(JSON.stringify({ error: String(e.message||e) }), { status: 500, headers: corsJson() });  
  }  
});

function cors(){ return {  
  "Access-Control-Allow-Origin":"\*",  
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS",  
  "Access-Control-Allow-Headers":"Content-Type,Authorization"  
};}  
function corsJson(){ return { ...cors(), "Content-Type":"application/json" }; }

async function pgc() {  
  const c \= new Client({ connectionString: DATABASE\_URL }); await c.connect(); return c;  
}

async function listSpans(req:Request){  
  const url \= new URL(req.url); const entity \= url.searchParams.get("entity\_type"); const status \= url.searchParams.get("status");  
  const limit \= Number(url.searchParams.get("limit")||50);  
  const c \= await pgc(); try {  
    await c.query(\`SET app.user\_id='api'; SET app.tenant\_id='voulezvous';\`);  
    // ✅ SECURITY: Parameterized query prevents SQL injection  
    let q \= \`SELECT \* FROM ledger.universal\_registry WHERE is\_deleted=false\`, p:any\[\]=\[\];  
    if (entity){ p.push(entity); q+=\` AND entity\_type=$${p.length}\`; }  
    if (status){ p.push(status); q+=\` AND status=$${p.length}\`; }  
    p.push(limit); q+=\` ORDER BY at DESC LIMIT $${p.length}\`;  
    const { rows } \= await c.query(q, p); return new Response(JSON.stringify(rows), { headers: corsJson() });  
  } finally { await c.end(); }  
}

async function createSpan(req:Request){  
  const body \= await req.json();  
  const c \= await pgc(); try {  
    await c.query(\`SET app.user\_id=$1\`, \[body.owner\_id||"api:web"\]);  
    if (body.tenant\_id) await c.query(\`SET app.tenant\_id=$1\`, \[body.tenant\_id\]);  
    body.id \= body.id || crypto.randomUUID(); body.seq \= body.seq ?? 0; body.at \= new Date().toISOString();  
    const cols \= Object.keys(body), vals \= Object.values(body), placeholders \= cols.map((\_,i)=\>\`$${i+1}\`).join(",");  
    const { rows } \= await c.query(\`INSERT INTO ledger.universal\_registry (${cols.map(c=\>\`"${c}"\`).join(",")}) VALUES (${placeholders}) RETURNING \*\`, vals);  
    return new Response(JSON.stringify(rows\[0\]), { headers: corsJson() });  
  } finally { await c.end(); }  
}

async function timeline(req:Request){  
  const url \= new URL(req.url); const visibility \= url.searchParams.get("visibility")||"tenant"; const limit \= Number(url.searchParams.get("limit")||50);  
  const c \= await pgc(); try {  
    await c.query(\`SET app.user\_id='api'; SET app.tenant\_id='voulezvous';\`);  
    const { rows } \= await c.query(\`SELECT \* FROM ledger.visible\_timeline WHERE visibility=$1 OR visibility='public' ORDER BY "when" DESC LIMIT $2\`, \[visibility, limit\]);  
    return new Response(JSON.stringify(rows), { headers: corsJson() });  
  } finally { await c.end(); }  
}

async function executeNow(req:Request){  
  const { span\_id } \= await req.json();  
  // In production, call request\_worker/observer flow; here we call run\_code directly via Stage-0 endpoint or queue.  
  return new Response(JSON.stringify({ scheduled\_for: span\_id }), { headers: corsJson() });  
}

async function metrics(){  
  const c \= await pgc(); try {  
    await c.query(\`SET app.user\_id='api:metrics'; SET app.tenant\_id='voulezvous';\`);  
    const counts \= await c.query(\`  
      SELECT date("when") AS day, status, count(\*)::int AS n  
      FROM ledger.visible\_timeline WHERE entity\_type='execution'  
      GROUP BY 1,2 ORDER BY 1 DESC, 2 ASC LIMIT 200\`);  
    const latency \= await c.query(\`  
      SELECT date("when") AS day, avg(duration\_ms)::int AS avg\_ms,  
             percentile\_cont(0.95) WITHIN GROUP (ORDER BY duration\_ms) AS p95\_ms  
      FROM ledger.visible\_timeline WHERE entity\_type='execution'  
      GROUP BY 1 ORDER BY 1 DESC LIMIT 30\`);  
    return new Response(JSON.stringify({ counts: counts.rows, latency: latency.rows }), { headers: corsJson() });  
  } finally { await c.end(); }  
}

async function streamTimeline(\_req:Request){  
  const c \= await pgc();  
  await c.query(\`SET app.user\_id='api:sse'; SET app.tenant\_id='voulezvous'\`);  
  await c.query(\`LISTEN timeline\_updates\`);  
  const stream \= new ReadableStream({  
    start(controller) {  
      // @ts-ignore  
      c.on("notification", (msg:any) \=\> controller.enqueue(new TextEncoder().encode(\`data: ${msg.payload}\\n\\n\`)));  
      // Keep-alive ping every 30s to prevent timeout  
      const keepAlive \= setInterval(() \=\> {  
        try { controller.enqueue(new TextEncoder().encode(":ping\\n\\n")); }  
        catch { clearInterval(keepAlive); }  
      }, 30000);  
    },  
    cancel() {  
      // ✅ FIX: Only end THIS connection, not shared pool  
      c.end().catch(() \=\> {});  
    }  
  });  
  return new Response(stream, { headers: { ...cors(), "Content-Type":"text/event-stream", "Cache-Control":"no-cache", "Connection":"keep-alive" }});  
}

### **7.2 OpenAPI (LLM‑friendly) / OpenAPI (amigável a LLMs)**

openapi: 3.1.0  
info:  
  title: LogLineOS API  
  version: "1.0"  
servers:  
  \- url: https://your-logline-api.example.com  
paths:  
  /api/spans:  
    get:  
      summary: List spans  
      parameters:  
        \- in: query; name: entity\_type; schema: { type: string }  
        \- in: query; name: status; schema: { type: string }  
        \- in: query; name: limit; schema: { type: integer, default: 50 }  
      responses:  
        "200": { description: OK, content: { application/json: { schema: { type: array, items: { $ref: "\#/components/schemas/Span" }}}}}  
    post:  
      summary: Create span (append-only)  
      requestBody: { required: true, content: { application/json: { schema: { $ref: "\#/components/schemas/Span" }}}}  
      responses: { "200": { description: Created, content: { application/json: { schema: { $ref: "\#/components/schemas/Span" }}}}}  
  /api/timeline:  
    get:  
      summary: Visible timeline  
      parameters:  
        \- in: query; name: visibility; schema: { type: string, enum: \[public, tenant, private\], default: tenant }  
        \- in: query; name: limit; schema: { type: integer, default: 50 }  
      responses:  
        "200": { description: OK, content: { application/json: { schema: { type: array, items: { $ref: "\#/components/schemas/Span" }}}}}  
  /api/execute:  
    post:  
      summary: Schedule/trigger execution for a function span  
      requestBody: { required: true, content: { application/json: { schema: { type: object, properties: { span\_id: { type: string, format: uuid }}, required: \[span\_id\] }}}}  
      responses: { "200": { description: Accepted } }  
  /api/metrics:  
    get:  
      summary: Execution metrics  
      responses: { "200": { description: OK } }  
  /api/timeline/stream:  
    get:  
      summary: Server-Sent Events stream of new spans  
      responses: { "200": { description: "text/event-stream" } }  
components:  
  schemas:  
    Span:  
      type: object  
      properties:  
        id: { type: string, format: uuid }  
        seq: { type: integer, minimum: 0 }  
        entity\_type: { type: string }  
        who: { type: string }  
        did: { type: string }  
        this: { type: string }  
        at: { type: string, format: date-time }  
        parent\_id: { type: string, format: uuid, nullable: true }  
        related\_to: { type: array, items: { type: string, format: uuid } }  
        owner\_id: { type: string }  
        tenant\_id: { type: string }  
        visibility: { type: string, enum: \[private, tenant, public\] }  
        status: { type: string }  
        name: { type: string }  
        description: { type: string }  
        code: { type: string }  
        language: { type: string }  
        runtime: { type: string }  
        input: { type: object, additionalProperties: true }  
        output: { type: object, additionalProperties: true }  
        error: { type: object, additionalProperties: true }  
        duration\_ms: { type: integer }  
        trace\_id: { type: string }  
        prev\_hash: { type: string }  
        curr\_hash: { type: string }  
        signature: { type: string }  
        public\_key: { type: string }  
        metadata: { type: object, additionalProperties: true }  
      required: \[id, seq, entity\_type, who, this, at, visibility\]  
---

## **8\) Frontend‑agnostic Adapters / Adaptadores agnósticos de Frontend**

* Next.js \+ shadcn dashboard (timeline, functions, execute) — provided earlier.

* Telegram Worker — provided earlier.

* Universal client (TS) — provided earlier.

* HTMX/SSR — trivial, call the API endpoints.

(Reuse the code from previous messages; unchanged.)

---

## **9\) Prompt System Seeds / Sementes do Sistema de Prompts**

* Blocks: doctrine, product, app, behavioral\_prior

* Variant: faq\_answerer@v1 (includes prior)

* Eval cards: happy‑path \+ stress

* Kernels: build (compiled\_hash), runner (telemetry), eval (stress), bandit (selection)

(SQL seeds were provided earlier; consolidate them as needed.)

---

## **10\) Operations Playbook / Runbook Operacional**

EN

* Recommended runtime: Deno on Cloud Run/Fly/Railway; Node is supported but avoid child\_process/fs; use Workers.

* Crons:

  * observer\_bot\_kernel : every 2–10s

  * request\_worker\_kernel: every 2–10s

  * policy\_agent\_kernel  : every 5–30s

  * prompt\_eval\_kernel   : nightly (per family/variant)

  * prompt\_bandit\_kernel : daily (per family)

* Key management: keep Ed25519 private key only in Stage‑0 env; rotate via manifest override\_pubkey\_hex.

* Quotas: per‑tenant daily executions in Manifest; override requires signed “force”.

* SSE: LISTEN/NOTIFY wired via trigger; fallback to polling if platform blocks LISTEN.

* Backups: continuous archiving (WAL) or daily base \+ WAL; table is append‑only.

PT

* Runtime recomendado: Deno (Cloud Run/Fly/Railway). Evite child\_process/fs.

* Crons: conforme acima.

* Chaves: Ed25519 privada apenas no Stage‑0; rotação via override\_pubkey\_hex.

* Cotas: por tenant/dia no Manifest; override exige “force” assinado.

* SSE: LISTEN/NOTIFY via trigger; fallback em polling.

* Backups: WAL contínuo ou base diária \+ WAL. Tabela é append‑only.

---

## **11\) Security Notes / Notas de Segurança**

* Ledger‑only: All business logic inside spans function. Stage‑0 is a fixed loader.

* Idempotency: advisory locks per span.id and idempotent request inserts.

* Proofs: deterministic BLAKE3 \+ optional Ed25519 signature on emitted spans.

* RLS: strict ownership/tenant/visibility checks; all API calls set app.user\_id/app.tenant\_id.

---

## **12\) LLM‑friendly Index / Índice amigável a LLMs**

* OpenAPI (above) for discovery

* Span JSON Schema (OpenAPI component)

* Stable IDs for kernels/policies/variants

* Compiled prompt hash recorded in prompt\_build \+ carried in prompt\_run.input.compiled\_hash

* Telemetry: prompt\_run.output.latency\_ms, provider model, trace\_id

---

## **13\) Our *Trajectory* / Nossa Trajetória**

* From tables to semantics: \~70 columns carry meaning; entities fill only what’s needed (sparse, queryable).

* From services to spans: executors, observers, policies, providers, prompts — everything is a span.

* From craft to engineering: prompts as contracts (schemas), compiled with priority blocks, hashed, evaluated, and auto‑promoted by bandit policy.

* From demos to production: quotas, locks, slow markers, SSE, metrics, OpenAPI, and governance via Manifest.

---

## **14\) Quickstart Commands / Comandos Rápidos**

Compile a variant → build prompt

deno run \-A stage0\_loader.ts \\  
  BOOT\_FUNCTION\_ID=c0c0c0c0-0000-4000-8000-bldp00000001 \\  
  VARIANT\_ID=bbbb0000-0000-4000-8000-vfaq00000001 \\  
  DATABASE\_URL="postgres://..." APP\_USER\_ID="edge:build" APP\_TENANT\_ID="voulezvous"

Run a user request

deno run \-A stage0\_loader.ts \\  
  BOOT\_FUNCTION\_ID=c0c0c0c0-0000-4000-8000-runp00000001 \\  
  VARIANT\_ID=bbbb0000-0000-4000-8000-vfaq00000001 \\  
  PROVIDER\_ID=00000000-0000-4000-8000-000000000101 \\  
  USER\_INPUT="When founded?" CONTEXT\_TEXT="Founded in 2012." \\  
  OPENAI\_API\_KEY="sk-..." DATABASE\_URL="..." \\  
  APP\_USER\_ID="edge:prompt" APP\_TENANT\_ID="voulezvous"

Evaluate (happy+stress)

deno run \-A stage0\_loader.ts \\  
  BOOT\_FUNCTION\_ID=c0c0c0c0-0000-4000-8000-eval00000001 \\  
  VARIANT\_ID=bbbb0000-0000-4000-8000-vfaq00000001 \\  
  PROVIDER\_ID=00000000-0000-4000-8000-000000000101 \\  
  EVAL\_ID=dddd0000-0000-4000-8000-evfq00000001 \\  
  OPENAI\_API\_KEY="sk-..." DATABASE\_URL="..." \\  
  APP\_USER\_ID="edge:eval" APP\_TENANT\_ID="voulezvous"

Daily bandit

deno run \-A stage0\_loader.ts \\  
  BOOT\_FUNCTION\_ID=c0c0c0c0-0000-4000-8000-band00000001 \\  
  PROMPT\_FAMILY=faq\_answerer WINDOW\_DAYS=1 \\  
  DATABASE\_URL="..." APP\_USER\_ID="edge:bandit" APP\_TENANT\_ID="voulezvous"  
---

## **15\) What we improved vs. earlier drafts / O que melhoramos**

* Unified “at/when” handling & view compatibility

* Hardened run\_code: whitelist, tenant check, throttle, manifest slow\_ms, timeout=slow\_ms

* Compiled prompt hash recorded & propagated

* Stress fixtures and eval kernel support

* Circuit breaker and confidence escalation policies

* Added TTL reaper to auto‑expire injected blocks

* Consistent advisory locks and idempotency

* OpenAPI \+ SSE out‑of‑the‑box

* Clear guidance on Deno-first runtime for safe Workers

---

# **Appendix / Apêndice**

### **A. Kernel & Policy IDs (stable) / IDs de Kernels & Políticas (estáveis)**

* run\_code\_kernel — 00000000-0000-4000-8000-000000000001

* observer\_bot\_kernel — 00000000-0000-4000-8000-000000000002

* request\_worker\_kernel — 00000000-0000-4000-8000-000000000003

* policy\_agent\_kernel — 00000000-0000-4000-8000-000000000004

* provider\_exec\_kernel — 00000000-0000-4000-8000-000000000005

* build\_prompt\_kernel — c0c0c0c0-0000-4000-8000-bldp00000001

* prompt\_runner\_kernel — c0c0c0c0-0000-4000-8000-runp00000001

* prompt\_eval\_kernel — c0c0c0c0-0000-4000-8000-eval00000001

* prompt\_bandit\_kernel — c0c0c0c0-0000-4000-8000-band00000001

* Policies: slow\_exec\_policy (…401), metrics\_exec\_duration\_policy (…402), daily\_exec\_rollup\_policy (…403), error\_report\_policy (…404), throttle\_policy (…405), prompt\_circuit\_breaker\_policy (…001), prompt\_confidence\_escalation\_policy (…002), ttl\_reaper\_policy (…003)

* kernel\_manifest — 00000000-0000-4000-8000-0000000000aa

---

### **B. LLM Cheatsheet / Cola para LLMs**

* Goal: Answer using only ledger context unless provider call requested.

* Cite: When using web or provider outputs, include related\_to references in spans.

* Contract: If schema cannot be satisfied, emit { "error": "Insufficient evidence." }.

* One clarifying question maximum; else proceed best‑effort and state assumptions.

* Never promise background work; every action must happen now with a span.

---

Below is the official LogLineOS Prompt System — brand‑wide, production‑ready, ledger‑only and designed to be replicated across all your apps.

I’m giving you: (1) what it is (principles \+ contracts), (2) how it works (architecture \+ kernels you already have), (3) exact artifacts (blocks/variants/seeds), and (4) frontend adapters (Next/Telegram) so it actually runs today.

Everything is bilingual (EN/PT). Copy/paste the SQL and TS snippets; no hidden steps.

---

# **0\) Purpose / Propósito**

EN — Your assistants (chat/brainstorming/attendants/agents) must be: polite, fresh, expert, communicative, and also deeply fluent in LogLineOS. We achieve this by a prompt system, not a single prompt. It is composable, versioned, measurable, and ledger‑only so the same behavior replicates across every frontend.

PT — Seus assistentes (chat/brainstorming/atendimento/agentes) precisam ser: educados, atuais, especialistas, comunicativos e fluentes no LogLineOS. Fazemos isso com um sistema de prompt, não um texto mágico. É componível, versionado, mensurável e 100% ledger, logo o mesmo comportamento replica em qualquer frontend.

—-----

Feito. Publiquei no canvas o  “LogLineOS Core for macOS — v1 (Greenfield Spec)”: uma especificação completa, partindo do zero no macOS e assumindo apenas que o LogLineOS (Postgres) Cloud já existe.

Ele cobre: arquitetura, segurança/privacidade, lifecycle (enrollment/observer/notary), schemas de spans, SDK Swift, XPC service, SSE, outbox/retry, packaging & notarization, SLOs/KPIs, testes e critérios de aceitação — tudo pronto para execução pela equipe.

---

# **1\) Principles / Princípios**

* Contracts, not vibes: every prompt defines an output schema and tool policy.

* Priority composition: Doctrine \> Product \> App \> Task (higher overrides lower).

* One clarifying question max; otherwise best‑effort with stated assumptions.

* Telemetry: record compiled\_hash, model, latency, tool\_use\_count, trace\_id.

* Ledger‑only: blocks/variants/builds/runs/evals are spans; Stage‑0 is the loader.

* Brand voice: a one‑sentence behavioral prior at top (proven win).

* Safety: refuse/redirect per policy; never reveal hidden chain‑of‑thought.

---

# **2\) Architecture / Arquitetura**

Frontend (Next/Telegram/Anything)  
   │  calls /api/chat → prompt\_runner\_kernel  
   ▼  
Ledger:  
  prompt\_block (doctrine/product/app/task/behaviour)  
  prompt\_variant (family@version)        ← chosen by bandit  
  build\_prompt\_kernel (compiled\_hash)  
  prompt\_runner\_kernel (telemetry model+hash)  
  provider\_exec\_kernel (OpenAI/Ollama)  
  prompt\_eval\_kernel (happy+stress fixtures)  
  prompt\_bandit\_kernel (daily selection)  
Policies:  
  circuit\_breaker (tool overuse) · confidence\_escalation (human review)  
  ttl\_reaper (auto‑expire injected blocks)

Result: every reply is traceable to a variant and compiled\_hash.

---

# **3\) Canonical Contracts / Contratos Canônicos**

## **3.1 Output Schema (all assistants)**

EN JSON schema (LLM‑friendly):

{  
  "type":"object",  
  "properties":{  
    "text":{"type":"string"},  
    "follow\_up\_question":{"type":"string","nullable":true},  
    "actions":{"type":"array","items":{"type":"object","properties":{  
      "type":{"type":"string","enum":\["create\_span","execute\_function","query","none"\]},  
      "args":{"type":"object","additionalProperties":true}  
    }}, "default":\[\]},  
    "citations":{"type":"array","items":{"type":"string"}, "default":\[\]},  
    "confidence":{"type":"number","minimum":0,"maximum":1},  
    "telemetry":{"type":"object","properties":{  
      "tool\_use\_count":{"type":"integer","minimum":0}  
    }, "additionalProperties":true}  
  },  
  "required":\["text","confidence"\]  
}

PT — O assistente sempre retorna um objeto com: text, confidence, opcionalmente follow\_up\_question, actions, citations, telemetry.tool\_use\_count.

If schema can’t be satisfied: {"error":"Insufficient evidence."} (PT: "Evidência insuficiente.").

## **3.2 Tool Policy (summary)**

* Prefer ledger retrieval (timeline, metrics) before external web.

* Use provider\_exec\_kernel for language generation only.

* Every tool use increments telemetry.tool\_use\_count.

* If tool calls in one turn would exceed 5 → stop and synthesize (circuit breaker).

---

# **4\) Brand Doctrine Block / Bloco Doutrinário de Marca**

High‑priority behavioral prior \+ brand tone. Replicate across apps.  
INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,content,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-doc-0001-0000-4000-8000-brandvoice0001',0,'prompt\_block','dan','defined','doctrine',now(),'active',  
'voulezvous\_doctrine\_en\_pt',  
'You are a precise, warm and proactive assistant. Be natural, expert, and concise by default. Explain only when asked.  
Você é um assistente preciso, acolhedor e proativo. Seja natural, especialista e conciso por padrão. Explique apenas quando solicitado.',  
'{"priority":120,"vars":{"language":"English & Portuguese","tz":"UTC","tone":"polite, fresh, expert, communicative"}}'::jsonb,  
'daniel','voulezvous','tenant');  
---

# **5\) Product/App/Task Blocks / Blocos de Produto/App/Tarefa**

### **5.1 Product (LogLineOS operations)**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,content,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-doc-0002-0000-4000-8000-product0001',0,'prompt\_block','dan','defined','product',now(),'active',  
'logline\_ops\_rules',  
'\# RULES  
\- Use the LogLineOS API or kernels to create/execute/query spans, never promise background work.  
\- One clarifying question if blocked; else best-effort and list assumptions.  
\- Always return the JSON schema above. If unsafe/insufficient, return the error object.  
\- Cite span IDs you used in "citations".  
\- Timezone: {tz}. Language: auto-detect user → mirror response (EN/PT).',  
'{"priority":100,"vars":{"tz":"UTC"}}'::jsonb,  
'daniel','voulezvous','tenant');

### **5.2 App adapter (Chat General)**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,content,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-app-0001-0000-4000-8000-chatgen0001',0,'prompt\_block','dan','defined','app',now(),'active',  
'chat\_general\_adapter',  
'\# ROLE & MISSION  
You are a general conversation/brainstorming agent for Voulezvous and LogLineOS.  
Mission: help the user think, write and act through the ledger. Non-goals: long essays without actions.',  
'{"priority":90}'::jsonb,  
'daniel','voulezvous','tenant');

### **5.3 Task (Tool usage hints)**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,content,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-task-0001-0000-4000-8000-tools0001',0,'prompt\_block','dan','defined','task',now(),'active',  
'tool\_usage\_hints',  
'- Prefer ledger queries over assumptions.  
\- If you schedule an execution, propose an "actions" item: {"type":"execute\_function","args":{"span\_id":"..."}}  
\- Never leak internal chain-of-thought.',  
'{"priority":70}'::jsonb,  
'daniel','voulezvous','tenant');  
---

# **6\) Variant:** 

# **vv\_chat\_agent@v1**

#  **(replicable across apps)**

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,metadata,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-var-0001-0000-4000-8000-chatv10001',0,'prompt\_variant','dan','defined','vv\_chat\_agent@v1',now(),'active',  
'vv\_chat\_agent@v1',  
jsonb\_build\_object(  
  'family','vv\_chat\_agent',  
  'block\_ids', ARRAY\[  
    'vv-doc-0001-0000-4000-8000-brandvoice0001'::uuid,  
    'vv-doc-0002-0000-4000-8000-product0001'::uuid,  
    'vv-app-0001-0000-4000-8000-chatgen0001'::uuid,  
    'vv-task-0001-0000-4000-8000-tools0001'::uuid  
  \],  
  'vars', jsonb\_build\_object(  
    'few\_shots', '\[{"input":"Schedule a run for double","context":"function id 1111..., status draft","output":{"text":"I can schedule it now.","actions":\[{"type":"execute\_function","args":{"span\_id":"1111..."}}\],"citations":\["1111..."\],"confidence":0.76,"telemetry":{"tool\_use\_count":1}}}\]',  
    'tone', 'polite, fresh, expert'  
  )  
),  
'daniel','voulezvous','tenant');  
This is your brand‑wide default. Other apps can extend it with extra blocks (lower priority) or create vv\_chat\_agent@v2 for experimentation.  
---

# **7\) Build/Run/Eval (you already have kernels)**

Use the kernels from our hardening pack:

* build\_prompt\_kernel (compiled\_hash in prompt\_build.output.compiled\_hash)

* prompt\_runner\_kernel (logs model, compiled\_hash, latency, raw)

* prompt\_eval\_kernel (happy \+ stress fixtures)

* prompt\_bandit\_kernel (daily winner per family)

Seeds for eval (happy+stress):

INSERT INTO ledger.universal\_registry  
(id,seq,entity\_type,who,did,"this",at,status,name,input,owner\_id,tenant\_id,visibility)  
VALUES  
('vv-eval-0001-0000-4000-8000-chatv1eval',0,'prompt\_eval','dan','defined','eval\_card',now(),'active',  
'vv\_chat\_agent\_eval\_v1',  
'{  
  "prompt\_id":"vv\_chat\_agent",  
  "fixtures":\[  
    {"type":"happy","input":"Say hi and tell me what LogLineOS does","context":"LogLineOS is a ledger-only backend.","must\_contain":\["ledger-only"\]},  
    {"type":"ambiguous","input":"run it","context":"function 1111 exists","must\_contain":\["actions"\]},  
    {"type":"overlong\_context","input":"summarize this","context":"(repeat) LogLineOS ledger-only x 100","must\_contain":\["ledger-only"\]},  
    {"type":"conflicting","input":"be super verbose","context":"Policy: be concise.","must\_contain":\[\]},  
    {"type":"tool\_unavailable","input":"use external web","context":"web disabled","must\_error":true}  
  \]  
}'::jsonb,  
'daniel','voulezvous','tenant');  
---

# **8\) Frontend Adapter (Next.js) / Adaptador de Frontend (Next.js)**

A thin /api/chat route that:

1. reads current variant (vv\_chat\_agent@v1 or bandit’s winner),

2. calls build\_prompt\_kernel → gets system\_prompt \+ compiled\_hash,

3. assembles messages \[system, context, user\],

4. calls provider\_exec\_kernel via prompt\_runner\_kernel,

5. returns the schema above (validates \+ fills defaults), and logs feedback if provided.

// app/api/chat/route.ts  
export const runtime \= "nodejs";  
import { NextRequest } from "next/server";  
import pg from "pg";  
const { Client } \= pg;

const DB \= process.env.DATABASE\_URL\!;

async function runKernel(id: string, env: Record\<string,string\>) {  
  // Minimal remote exec: we rely on your Stage-0 runner process, or call via queue.  
  // For local dev, you can trigger kernels by inserting a request span and having a worker pick it up.  
  // Here, we just return 202 to UI and rely on prompt\_runner API if you prefer.  
  return { ok: true };  
}

export async function POST(req: NextRequest) {  
  const body \= await req.json();  
  const userText \= String(body?.text || "");

  const c \= new Client({ connectionString: DB }); await c.connect();  
  try {  
    await c.query(\`SET app.user\_id='web:chat'; SET app.tenant\_id='voulezvous'\`);  
    // 1\) Resolve variant (last selection or default)  
    const current \= await c.query(\`  
      SELECT COALESCE(pc.variant\_id, 'vv-var-0001-0000-4000-8000-chatv10001') AS variant\_id  
      FROM (SELECT (output-\>'current'-\>\>'id') AS variant\_id  
            FROM ledger.visible\_timeline  
            WHERE entity\_type='prompt\_variant\_selection' AND this='vv\_chat\_agent'  
            ORDER BY "when" DESC LIMIT 1\) pc\`);  
    const VARIANT\_ID \= current.rows\[0\].variant\_id;

    // 2\) Build prompt (ensure a recent build exists)  
    // In prod: call Stage-0 with BOOT\_FUNCTION\_ID=build kernel. Here: trust latest prompt\_build.  
    const build \= await c.query(\`  
      SELECT output FROM ledger.visible\_timeline  
      WHERE entity\_type='prompt\_build' AND related\_to @\> ARRAY\[$1\]::uuid\[\]  
      ORDER BY "when" DESC LIMIT 1\`, \[VARIANT\_ID\]);  
    let system\_prompt \= build.rows\[0\]?.output?.system\_prompt;  
    let compiled\_hash \= build.rows\[0\]?.output?.compiled\_hash;

    if (\!system\_prompt) {  
      // Optionally trigger build; for now, fallback to minimal stitched prompt  
      const stitched \= await c.query(\`  
        SELECT content, (metadata-\>\>'priority')::int p  
        FROM ledger.visible\_timeline WHERE id \= ANY(  
          (SELECT (metadata-\>'block\_ids')::jsonb FROM ledger.visible\_timeline  
           WHERE id=$1 ORDER BY "when" DESC LIMIT 1)::uuid\[\]  
        ) ORDER BY p DESC NULLS LAST, "when" DESC\`, \[VARIANT\_ID\]);  
      system\_prompt \= stitched.rows.map((r:any)=\>r.content).join("\\n\\n");  
      compiled\_hash \= "fallback-"+Date.now();  
    }

    // 3\) Create messages  
    const messages \= \[  
      { role: "system", content: system\_prompt },  
      ...(body.context ? \[{ role: "system", content: "CONTEXT:\\n" \+ String(body.context) }\] : \[\]),  
      { role: "user", content: userText }  
    \];

    // 4\) Call provider via prompt\_runner (or directly provider\_exec; runner logs telemetry+hash)  
    // Minimal path: insert a "prompt\_run\_request" span and have a worker execute prompt\_runner\_kernel.  
    await c.query(\`  
      INSERT INTO ledger.universal\_registry  
      (id,seq,entity\_type,who,did,"this",at,status,input,owner\_id,tenant\_id,visibility,related\_to)  
      VALUES (gen\_random\_uuid(),0,'prompt\_run\_request','web:chat','scheduled','prompt.run',now(),'scheduled',  
              jsonb\_build\_object('variant\_id',$1,'messages',$2,'compiled\_hash',$3),  
              'web:chat','voulezvous','tenant', ARRAY\[$1\]::uuid\[\])\`,  
      \[VARIANT\_ID, JSON.stringify(messages), compiled\_hash\]  
    );

    // You may also synchronously run the runner kernel here if needed.

    // 5\) Return a normalized envelope (text may be streamed by UI when provider returns)  
    return Response.json({  
      ok: true,  
      variant\_id: VARIANT\_ID,  
      compiled\_hash,  
      // UI will poll/stream provider\_execution or prompt\_run later  
      expected\_schema: "text, confidence, follow\_up\_question?, actions\[\], citations\[\], telemetry{}"  
    });  
  } finally { await c.end(); }  
}  
Telegram worker does the same: resolve variant → build prompt → messages → runner.  
---

# **9\) Policies that make it** 

# **behave**

#  **(already in your ledger)**

* Circuit breaker: if tool\_use\_count \> 5, inject temporary block (“synthesize now”).

* Confidence escalation: confidence \< 0.6 → escalation\_request.

* TTL reaper: auto‑expire injected blocks (30 min default).

* Slow/metrics/rollup/error: already installed for execution.

These guarantee polite, expert, action‑oriented behavior without loops or unbounded tool calls.

---

# **10\) Governance & Rollout / Governança e Rollout**

EN

* Default for all apps: vv\_chat\_agent@v1.

* Experiments: create vv\_chat\_agent@v2 variant; run eval \+ bandit; the winner becomes current.

* Every response logs prompt\_run with compiled\_hash; regressions are diffable.

* All blocks/variants live in ledger; frontends only call /api/chat \+ SSE.

PT

* Padrão em todos os apps: vv\_chat\_agent@v1.

* Experimentos: crie vv\_chat\_agent@v2, rode eval \+ bandit; a vencedora vira atual.

* Toda resposta registra prompt\_run com compiled\_hash; regressões são rastreáveis.

* Blocos/variantes vivem no ledger; frontends só chamam /api/chat \+ SSE.

---

# **11\) Example “rendered” prompt (what the model actually sees)**

(assembled from the blocks above; variables resolved)

\[Behavioral prior\]  
You are a precise, warm and proactive assistant. Be natural, expert, and concise by default. Explain only when asked.  
Você é um assistente preciso, acolhedor e proativo. Seja natural, especialista e conciso por padrão. Explique apenas quando solicitado.

\[Role & Mission\]  
You are a general conversation/brainstorming agent for Voulezvous and LogLineOS.  
Mission: help the user think, write and act through the ledger. Non-goals: long essays without actions.

\[Rules\]  
\- Use the LogLineOS API or kernels to create/execute/query spans, never promise background work.  
\- One clarifying question if blocked; else best-effort and list assumptions.  
\- Always return the JSON schema below. If unsafe/insufficient, return the error object.  
\- Cite span IDs you used in "citations".  
\- Timezone: UTC. Language: mirror user (PT/EN). Tone: polite, fresh, expert, communicative.

\[Output Schema Contract\]  
Return a JSON object:  
{text, follow\_up\_question?, actions\[\], citations\[\], confidence (0..1), telemetry{tool\_use\_count}}

\[Few-shots\]  
...  
---

# **12\) Why this will “de facto function”**

* Single source of truth (blocks/variants) → consistent brand voice across apps.

* Compiled hash → immutable audit per response.

* Kernels \+ policies → bounded tool use, escalations, metrics.

* Schema contract → frontends can render actions/buttons deterministically.

* Eval \+ bandit → quality goes up over time, not down.

* Bilingual by design → answers mirror the user.

---

## **Final notes / Notas finais**

* This is unique because it is a system (compiler \+ policies \+ telemetry \+ bandit) baked into your ledger‑only OS.

* It’s also replicable: new apps only need to use vv\_chat\_agent@v1 (or a family variant) and our /api/chat adapter.

—---

# **📘 LogLineOS Memory System — Official Specification (EN/PT)**

**Status:** Production‑ready  
**Scope:** Memory capture, storage, retrieval (RAG), session persistence, privacy/security, observability, governance  
**Backends:** Postgres (append‑only ledger) \+ optional pgvector  
**Frontends:** Any (Next.js, Telegram, mobile, etc.) — via HTTP API and tools  
**Design tenets:** ledger‑only, contract‑first, multitenant, auditable, privacy‑by‑default

---

## **0\) Executive Summary / Resumo Executivo**

**EN** — The LogLineOS Memory System turns user facts, preferences, notes, profiles and summaries into **append‑only spans** (`entity_type='memory'`) with optional **field‑level encryption**, strict **RLS**, and **session‑aware persistence**. Retrieval (RAG) prefers **session context**, then user, then tenant, then public. Every write emits a **tamper‑evident audit event**. Policies govern quotas, TTL/retention, and consent.

**PT** — O Sistema de Memória do LogLineOS transforma fatos, preferências, notas, perfis e resumos em **spans append‑only** (`entity_type='memory'`) com **criptografia opcional por campo**, **RLS** rígido e **persistência consciente de sessão**. A recuperação (RAG) prioriza **memória da sessão**, depois do usuário, do tenant e, por fim, pública. Toda escrita gera um **evento de auditoria à prova de adulteração**. Políticas controlam cotas, TTL/retenção e consentimento.

---

## **1\) Goals & Non‑Goals / Objetivos & Fora de Escopo**

**Goals**

* Contract‑first memory artifacts: **schema‑validated** `memory` spans  
* **Session persistence**: opt‑in, scoped, TTL‑bound memory per conversation/session  
* **Privacy**: consent‑gated capture, field‑level **AES‑256‑GCM**, **RLS**, redaction, export  
* **Quality**: promotion workflow (temporary → permanent), review states  
* **RAG**: ranked retrieval with circuit breaker and context budget  
* **Observability**: metrics, audits, rollups

**Non‑Goals**

* General long‑term document management (that’s your content system)  
* Irreversible hard deletes (we use append‑only \+ redaction for auditability)

---

## **2\) Data Model / Modelo de Dados**

### **2.1 Core Span (ledger.universal\_registry)**

Every memory is a span:

{

  "id": "uuid",

  "seq": 0,

  "entity\_type": "memory",

  "who": "kernel:memory|app|user",

  "did": "upserted|promoted|demoted|redacted",

  "this": "memory.{type}",

  "at": "2025-01-01T12:00:00Z",

  "status": "active|needsReview|archived",

  "content": { "text": "user said: I prefer dark mode" },      // or redacted=true if encrypted

  "metadata": {

    "layer": "session|temporary|permanent|shared|local",

    "type": "note|fact|profile|preference|relationship|plan|action|other",

    "schema\_id": "note.v1",

    "tags": \["ui", "preference"\],

    "sensitivity": "public|internal|secret|pii",

    "ttl\_at": "2025-01-08T00:00:00Z",

    "session\_id": "chat-session-uuid",       // session persistence

    "encryption\_iv": "hex12bytes?",          // if encrypted

    "encryption\_tag": "hex16bytes?"          // optional tag field

  },

  "owner\_id": "user-id",

  "tenant\_id": "voulezvous",

  "visibility": "private|tenant|public",

  "prev\_hash": "…",

  "curr\_hash": "…",

  "signature": "…",

  "trace\_id": "request/trace correlation"

}

**Audit chain** (append‑only):

{

  "entity\_type": "memory\_audit",

  "input": { "action": "upsert|promote|demote|redact", "memory\_id": "uuid", "diff": { /\* optional \*/ } },

  "curr\_hash": "rolling-hash"

}

### **2.2 Embeddings (optional, for ANN search)**

`ledger.memory_embeddings(span_id uuid PK, tenant_id text, dim int default 1536, embedding vector(1536), created_at timestamptz)`  
Use **pgvector** with IVFFlat or HNSW (provider‑dependent).

---

## **3\) Memory Scopes, Layers & Sessions / Escopos, Camadas & Sessões**

**Scopes (who can read):**

* **private** (owner only)  
* **tenant** (same tenant, per RLS & role)  
* **public** (org wide / docs)

**Layers (lifecycle & retention):**

* **session** — tied to `session_id`; short TTL (e.g., hours/days); default **off** unless session consent is **on**  
* **temporary** — short‑lived (days/weeks); promotable  
* **permanent** — long‑lived; reviewer approval required  
* **shared/local** — collaborative or device‑local patterns (opt‑in)

**Session persistence** (💡 focus requested):

* Each chat/request carries `session_id` (distinct from `trace_id`).  
* When **session memory is enabled**, the assistant may write memories with `metadata.session_id=session_id` and `layer='session'`.  
* Retrieval ranks by scope **in this order**:  
  1. **session** (exact `session_id`)  
  2. **private** memories of the user (temporary → permanent)  
  3. **tenant** memories (if allowed)  
  4. **public**  
* All session writes honor **TTL** and **consent flags**.

---

## **4\) Privacy & Security / Privacidade & Segurança**

**Consent & Controls**

* **Default**: memory writing is **off** unless session or user toggles **on** (`memory:on`).  
* Per‑request header **`X-LogLine-Memory`**: `off|session-only|on` (overrides UI setting).  
* User commands: “don’t remember”, “forget last”, “forget session”, “export my data”. These produce **redaction** or **export** spans (see §9.3).

**Encryption**

* Field‑level **AES‑256‑GCM** for `content` (and optionally `tags`).  
* Keys via per‑tenant KMS; IV+tag stored per row; ciphertext stored in `metadata.encrypted_*` or separate `encrypted_data` field if you prefer.  
* If encrypted, `content` should contain `{ "redacted": true }` to avoid plaintext exposure.

**RLS**

* Row Level Security ensures:  
  * **owner** can read private  
  * **tenant** read depends on role & `visibility`  
  * **public** readable by all tenant users  
* All API paths set `app.user_id` & `app.tenant_id`.

**Minimization**

* Memory classifier kernel rejects obvious transient/noise.  
* Avoid full transcripts; store **summaries/facts**.

**Auditing & DSR**

* Every write → `memory_audit` (rolling hash).  
* **Data Subject Requests**: “export” emits an **export artifact** (NDJSON/ZIP); “erase” appends a **redaction span** and optionally re‑encrypts the prior content with a **tombstone** note (append‑only).

---

## **5\) APIs / APIs**

### **5.1 Public surface (LLM & UI‑friendly)**

* `POST /api/memory` — upsert memory (schema‑validated, optional encryption; session‑aware)  
* `GET /api/memory/:id` — fetch one  
* `GET /api/memory/search` — filters \+ text (and vector if enabled)  
* *(optional)* `POST /api/memory/:id/promote` — temporary → permanent (review)  
* *(optional)* `GET /api/metrics/memory` — metrics snapshot  
* *(optional)* `GET /api/memory/reports` — quality/coverage reports  
* *(optional)* `POST /api/memory/session/:session_id/forget` — redacts session memories

**Session headers**

* `X-LogLine-Session: <uuid>`  
* `X-LogLine-Memory: off|session-only|on`  
* `X-LogLine-Sensitivity: public|internal|secret|pii` (default: internal)

*(OpenAPI stub available; see deliverables. You can enrich it with the optional routes.)*

---

## **6\) Kernels / Kernels**

**memory\_upsert\_kernel**

* Inputs: `MEMORY` object (`layer`, `type`, `content`, optional `tags`, `schema_id`, `sensitivity`, `ttl_at`, `session_id`)  
* If sensitivity \!= public and `KMS_HEX` present → encrypt `content` with AES‑GCM (per‑tenant key).  
* Emits: `memory` span \+ `memory_audit` span.

**memory\_search\_kernel**

* Inputs: `Q`, `TOPK`, `USE_VECTOR`  
* Outputs: `memory_search_result` with ranked hits.  
* Retrieval uses **scope ranking**: session → private → tenant → public (apply in your SQL or post‑filter the hits).

Both kernels are ready as NDJSON in your package; they align to ledger‑only, append‑only design.

---

## **7\) RAG Behavior / Comportamento RAG**

**Retrieval Plan**

1. Respect `X-LogLine-Memory`:  
   * `off` → **no retrieval or writes**  
   * `session-only` → retrieve/write only with `layer='session'` & `session_id`  
   * `on` → normal ranking (session → private → tenant → public)  
2. Query **text** first; if embeddings exist & budget allows, run **vector** as second pass.  
3. Merge & dedupe hits; cap by **context\_tokens budget**.  
4. Add to `CONTEXT` section for the model; include **citations** \= memory span IDs.  
5. Log `telemetry.tool_use_count` in `prompt_run`.

**Circuit Breaker**

* If tool calls in a turn would exceed 5 → stop and synthesize (policy injects “anti‑tool spam” block for \~30 min).  
* If `confidence < 0.6` in model output → `escalation_request` to human.

---

## **8\) Session Persistence / Persistência de Sessão**

**Write rules**

* Only write session memory if `X-LogLine-Memory != off` and either:  
  * the user gave explicit consent in UI for this session; or  
  * the message includes an explicit command (“remember this”).  
* Include `metadata.session_id` and set `layer='session'`; set `ttl_at` (e.g., \+7 days).

**Read rules**

* On each turn, get `session_id` from header/cookie; retrieve session hits first.  
* If `session-only`, stop there.

**Operations**

* **Forget last**: emit `status_patch` → `redacted` against the last `memory` span tied to `session_id` and user.  
* **Forget session**: emit `redaction` spans for all session memories (policy can batch).  
* **Export session**: emit an `export` span that collects the memory spans and streams NDJSON to the user.

---

## **9\) Workflows / Fluxos**

### **9.1 Promotion (temporary → permanent)**

* `memory` with `layer='temporary'` → `needsReview`.  
* Reviewer (`role: reviewer|admin`) approves → `did:'promoted'`, new `memory_audit`.  
* Deny → `did:'demoted'`, optional redaction.

### **9.2 TTL & Retention**

* Policy **ttl\_reaper\_policy**: when `ttl_at < now()` → emit `status_patch status=archived` and optionally **redact**content (keep metadata/audit).

### **9.3 DSR (Export & Erasure)**

* **Export**: `export_request` → worker builds NDJSON of user’s memories; create `export_artifact` span with a signed hash and a URL.  
* **Erase/Forget**: append `redaction`/`status_patch` spans; keep cryptographic trail, optionally re‑encrypt old ciphertext with a tenant “black‑hole” key to prevent recovery.

---

## **10\) Privacy FAQ / FAQ de Privacidade**

* **Can the model see raw PII?** Only if sensitivity is `public` or encryption is disabled. With AES‑GCM enabled, plaintext is not stored; the LLM sees only **summaries** or **redacted** forms in `content`.  
* **How to turn memory off?** UI toggle → `X-LogLine-Memory: off`; the runtime will neither read nor write memory.  
* **Per‑session consent?** Yes. We store a `consent_on` flag (session span) and require it for `layer='session'`.  
* **How do we delete?** Append **redaction**; don’t mutate prior rows (ledger‑only).  
* **Who can read what?** Enforced by **RLS** (owner/private vs tenant/public) and **roles** (viewer/editor/reviewer/admin).  
* **Where are keys?** In your KMS; kernels read a key handle/environment variable and fail closed if missing.

---

## **11\) Observability & Metrics / Observabilidade & Métricas**

Emit `metric` spans (policy or kernel) such as:

* `cerebro.mem.created`, `cerebro.mem.updated`, `cerebro.mem.promoted`  
* `cerebro.search.qps`, `cerebro.search.latency_ms_{p50,p95}`  
* `cerebro.cache.hit_rate_l1/l2` (if applicable)  
* `cerebro.quality.needs_review_count`  
* `cerebro.rag.cb_open_count`, `cerebro.rag.fallback_rate`

Dashboards:

* Writes over time; promotion funnel; TTL expirations; PII ratio; session‑only usage.

---

## **12\) Contracts (Schemas) / Contratos (Esquemas)**

### **12.1 MemoryUpsert (API)**

{

  "layer":"session|temporary|permanent|shared|local",

  "type":"note|fact|profile|preference|relationship|plan|action|other",

  "schema\_id":"note.v1",

  "content":{ "text":"..." },

  "tags":\["optional"\],

  "sensitivity":"public|internal|secret|pii",

  "ttl\_at":"2025-01-08T00:00:00Z",

  "session\_id":"uuid"

}

### **12.2 Retrieval Result**

{

  "hits":\[

    { "span\_id":"uuid", "score":0.83, "preview":"first 160 chars...", "layer":"session" }

  \]

}

---

## **13\) Frontend Integration / Integração com Frontend**

**Next.js Vercel AI (tools) — memory**

* Use the **LogLineOS Memory API** (see `lib.tools.vv.ts` from the package):  
  * `storeMemoryTool({ key, value, scope, layer, type, tags, sensitivity })` → POST `/api/memory`  
  * `retrieveMemoryTool({ q })` → GET `/api/memory/search?q=...`  
* Pass `X-LogLine-Session` and `X-LogLine-Memory` in requests based on user toggle.

**Conversation policy (LLM)**

* The assistant should **ask once** per session: “Can I remember preferences to improve this chat?”  
* If **no**, set header to `off`; if **yes**, set `session-only` or `on`, and show a chip “Memory: On”.

---

## **14\) Security Checklist / Checklist de Segurança**

*  RLS active; all API routes set `app.user_id/app.tenant_id`.  
*  AES‑GCM enabled for non‑public sensitivity; KMS key present; fail closed if missing.  
*  Append‑only: no UPDATE/DELETE; redaction via new spans.  
*  Session consent recorded; memory defaults to **off**.  
*  Export/Erasure flows append signed events.  
*  Tool calls bounded by circuit breaker; telemetry logged.  
*  Keys rotated via KMS; audit trails verified (hash chain intact).

---

## **15\) Example Policies / Políticas de Exemplo**

* **Memory classifier**: refuse trivial/volatile entries; enforce minimization.  
* **TTL reaper**: archive/redact on `ttl_at`.  
* **Promotion review**: only reviewers/admins can approve.  
* **Session forget**: when user requests, batch‑redact `session_id` memories.

---

## **16\) Mermaid Diagrams / Diagramas**

### **16.1 Write path**

sequenceDiagram

  participant UI as Frontend (Next/Telegram)

  participant API as LogLineOS API

  participant KRN as memory\_upsert\_kernel

  participant LED as Ledger (Postgres)

  UI-\>\>API: POST /api/memory (X-LogLine-Session, X-LogLine-Memory)

  API-\>\>LED: insert request span (scheduled)

  API--\>\>UI: 202 Accepted

  LED-\>\>KRN: worker picks request

  KRN-\>\>LED: insert memory span (+ audit, optional encryption)

  LED--\>\>UI: SSE/Timeline update (memory created)

### **16.2 Read path (RAG)**

sequenceDiagram

  UI-\>\>API: /api/chat (session headers)

  API-\>\>LED: memory\_search (session-\>private-\>tenant-\>public)

  LED--\>\>API: hits

  API-\>\>LLM: messages \[system \+ CONTEXT(memories) \+ user\]

  LLM--\>\>API: answer \+ confidence

  API-\>\>LED: prompt\_run (telemetry, citations)

---

## **17\) Rollout / Implantação**

1. Apply **pgvector** \+ `memory_embeddings` (migrations).  
2. Import **memory kernels** NDJSON, enable workers.  
3. Expose **/api/memory** endpoints; set **OpenAPI**.  
4. Patch frontend tools to call new API; add **session toggle** and headers.  
5. Turn on **policies** (TTL, promotion, consent prompts).  
6. Add dashboards & alerts (cb\_open\_count, needs\_review\_count, encryption missing).

---

## **18\) Bilingual User‑Facing Copy / Cópias para Usuário**

* **EN**: “Memory is **off** by default. Turn it on to let me remember preferences for this conversation only (session), or across your account. You can say ‘forget last’, ‘forget session’, or ‘export my data’ anytime.”  
* **PT**: “A memória vem **desativada** por padrão. Ative para eu lembrar suas preferências **apenas nesta conversa**(sessão) ou na sua conta. Você pode dizer ‘esqueça a última’, ‘esqueça a sessão’ ou ‘exportar meus dados’ a qualquer momento.”

---

## **19\) Appendix / Apêndice**

* **Source of truth:** all memory artifacts are **spans**; any tables (e.g., `memory_embeddings`) are **derived indices**.  
* **Compatibility:** maps cleanly from your CEREBRO EP1–EP5 (security, quality, RAG, autotune) to LogLineOS.  
* **LLM‑ready:** contracts are concise JSON schemas; endpoints documented in OpenAPI.

---

### **TL;DR**

* We persist memories **by session** (opt‑in, TTL), **by user**, and **by tenant/public**, all as **append‑only spans**.  
* Privacy is **enforced by design**: consent, encryption, RLS, redaction, and audit chains.  
* Frontends call a simple API; assistants retrieve with a bounded context budget, cite memory IDs, and log telemetry — making memory **safe, useful, and auditable**.

—---

# **LogLineOS Core for macOS — v1 (Greenfield Spec)**

Scope: Implement the macOS Core System that interacts with an already‑running LogLineOS (Postgres) Cloud. This spec assumes the ledger APIs exist and are reachable. No prior macOS code exists. We define architecture, security model, services, Swift APIs, packaging, ops, and validation.

---

## **0\) Objectives & Non‑Goals**

Objectives

* Provide a macOS‑native core that can: (1) observe local context (Observer), (2) notarize explicit events (Notary), (3) securely sign and ingest spans to the Cloud ledger, (4) consume SSE streams for real‑time state.

* Ship as a minimal, hardened baseline for future Conductor features.

Non‑Goals

* No IDE integration (that is a separate VS Code extension).

* No local ledger; persistence is limited to a cache and outbox.

---

## **1\) Architecture Overview**

graph TD

    subgraph "User Space (macOS)"

        MB\[Menu Bar App — Observer\]

        XPC\[XPC Service — Notary Core\]

        SDK\[Swift SDK — Ledger Client\]

        DB\[(Local Store: SQLite)\]

        KMS\[Keychain \+ Secure Enclave\]

    end

    subgraph "Cloud (Existing)"

        API\[LogLineOS Cloud API\]

        SSE\[Timeline SSE\]

        LGR\[(PostgreSQL Ledger)\]

    end

    MB \--\>|XPC calls| XPC

    MB \--\> SDK

    XPC \--\> SDK

    SDK \--\>|POST /api/spans| API

    SDK \--\>|GET /manifest/\*| API

    SSE \--\> MB

    SSE \--\> XPC

    SDK \--\> DB

    SDK \--\> KMS

    API \--\> LGR

Runtime Model

* Menu Bar App (Observer): lightweight UI \+ background sampling; zero elevated privileges.

* XPC Service (Notary Core): sealed boundary for signing, outbox/retry, SSE handling, policy hooks.

* Swift SDK: shared networking, signing, serialization, idempotency, backoff.

---

## **2\) Security, Privacy & Compliance**

* App Sandbox: enable; no filesystem wide access; request standard entitlements only.

* Entitlements:

  * com.apple.security.app-sandbox \= true

  * com.apple.security.network.client \= true

  * keychain-access-groups \= \<team\>.com.causable.keys

  * com.apple.developer.networking.networkextension (optional, if future proxy)

* Keys: Per‑device Ed25519 (Secure Enclave preferred; fallback to Keychain). Public key registered with Cloud on enrollment.

* Privacy: Observer emits low‑sensitivity activity spans; default visibility \= private. Any promotion to tenant/public requires explicit user action.

* Data minimization: Never upload raw source code. Notary transmits spans only (metrics, digests, fingerprints).

* Idempotence: X‑Idempotency‑Key \= HMAC(tenant\_id \+ digest); server must treat duplicates safely.

---

## **3\) Processes & Lifecycles**

### **3.1 First Run / Enrollment**

1. User launches Menu Bar App → onboarding wizard.

2. App generates Ed25519 key pair (Secure Enclave if available).

3. App calls POST /api/enroll with pubkey, device\_fingerprint → receives device\_id, tenant\_id, owner\_id.

4. Persist credentials in Keychain; set initial policies fetched from GET /manifest/loglineos\_core\_manifest@v1 and GET /manifest/causable\_apps\_manifest@v1.

### **3.2 Observer Loop (Menu Bar)**

* Sample foreground app \+ window title every N seconds (default 15s; adaptive backoff on energy impact).

* Debounce unchanged focus; coalesce bursts.

* Emit activity span into XPC outbox.

### **3.3 Notary Loop (XPC)**

* Maintain Outbox (SQLite) for pending spans with (span\_json, digest, tries, next\_attempt\_at).

* Signed upload with exponential backoff (jitter; max 30m).

* Listen SSE for policy\_update \+ command spans; apply changes.

### **3.4 Updates & Rollback**

* Use Sparkle for delta updates signed with developer key.

* Keep last working build for rollback.

---

## **4\) Data & Schemas (v1)**

### **4.1 Canonical Span Envelope**

{

  "id": "uuid-v7",

  "entity\_type": "activity | codebase\_snapshot | execution | policy\_update | ...",

  "who": "observer:menubar@1.0.0 | notary:xpc@1.0.0",

  "did": "focused | analyzed | executed | promoted | ...",

  "this": "device:\<uuid\> | local\_workspace:\<name\> | span:\<id\>",

  "status": "complete | active | error",

  "input": { /\* type-specific \*/ },

  "output": { /\* type-specific \*/ },

  "metadata": { "tenant\_id": "...", "owner\_id": "...", "device\_id": "...", "ts": "RFC3339" },

  "visibility": "private | tenant | public",

  "digest": "b3:\<hex\>",

  "signature": {"algo": "ed25519", "pubkey": "hex", "sig": "hex"}

}

### **4.2 Local DB (SQLite)**

* outbox(id PRIMARY KEY, digest UNIQUE, span\_json, tries INT, next\_attempt\_at TIMESTAMP)

* kv(key PRIMARY KEY, value\_json) for config/manifests cache

* Index on next\_attempt\_at for uploader scheduler

---

## **5\) Network Contracts (Cloud already exists)**

### **5.1 Ingest**

POST /api/spans

Headers:

  Authorization: Bearer \<device\_token\>

  X-Idempotency-Key: \<hmac\>

Body: \<span JSON\>

→ 200 { id, accepted\_at, digest }

### **5.2 Fetch Manifests**

GET /manifest/loglineos\_core\_manifest@v1

GET /manifest/causable\_apps\_manifest@v1

→ 200 \<json\>

### **5.3 SSE Timeline**

GET /api/timeline/stream?device\_id=\<id\>\&tenant\_id=\<t\>

Accept: text/event-stream

---

## **6\) Swift SDK (FoundationNetworking)**

### **6.1 Package Layout**

CausableSDK/

  Sources/

    CausableSDK/

      Client.swift

      Signer.swift

      Envelope.swift

      Outbox.swift

      SSEClient.swift

      Manifests.swift

  Tests/

### **6.2 Core APIs (prototypes)**

public struct SpanEnvelope: Codable { /\* fields as schema above \*/ }

public protocol SpanSigner {

    func publicKeyHex() throws \-\> String

    func sign(\_ digest: Data) throws \-\> Data

}

public final class CausableClient {

    public init(baseURL: URL, tokenProvider: () \-\> String, signer: SpanSigner, db: OutboxStore) { /\* ... \*/ }

    public func ingest(span: SpanEnvelope) async throws \-\> String { /\* returns id \*/ }

    public func fetchManifest(name: String) async throws \-\> Data { /\* ... \*/ }

    public func sseStream(params: \[URLQueryItem\]) \-\> AsyncThrowingStream\<Data, Error\> { /\* ... \*/ }

}

public final class OutboxStore { /\* SQLite wrapper with nextAttempt() \*/ }

### **6.3 Signing Flow**

let canonical \= try JSONEncoder.causableCanonical.encode(span)

let digest \= blake3(canonical)

let sig \= try signer.sign(digest)

span.digest \= "b3:" \+ digest.hex

span.signature \= Signature(algo: "ed25519", pubkey: signer.publicKeyHex(), sig: sig.hex)

---

## **7\) Menu Bar App (Observer)**

### **7.1 Responsibilities**

* Foreground app/window sampling; low‑power cadence.

* Quick controls: pause observing, promote last N spans to tenant, privacy mode toggle.

* Status indicators: upload backlog, SSE connectivity, policy version.

### **7.2 Tech Stack**

* SwiftUI for UI; AppKit for menu bar.

* Combine for reactive streams; async/await for IO.

### **7.3 Sampling Implementation**

* Use NSWorkspace.shared.notificationCenter for app activation.

* Fallback polling every 15s via CGWindowListCopyWindowInfo for window titles (redact known sensitive patterns).

---

## **8\) XPC Service (Notary Core)**

### **8.1 Responsibilities**

* Exclusive access to signer; no private key leaves process.

* Outbox management \+ upload scheduling.

* SSE listener → command/policy application.

### **8.2 Interface**

@objc protocol NotaryXPC {

    func enqueueSpan(\_ span: Data, with reply: @escaping (Bool, String?) \-\> Void)

    func setPolicy(\_ json: Data, with reply: @escaping (Bool) \-\> Void)

    func health(\_ reply: @escaping (String) \-\> Void)

}

### **8.3 Launchd Plist (XPC)**

\<?xml version="1.0" encoding="UTF-8"?\>

\<\!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"\>

\<plist version="1.0"\>

\<dict\>

  \<key\>Label\</key\>\<string\>dev.causable.notary\</string\>

  \<key\>MachServices\</key\>\<dict\>\<key\>dev.causable.notary\</key\>\<true/\>\</dict\>

  \<key\>RunAtLoad\</key\>\<true/\>

  \<key\>KeepAlive\</key\>\<true/\>

\</dict\>

\</plist\>

---

## **9\) Configuration & Manifests**

* Cache core & apps manifests locally with ETag.

* Apply throttle and slow\_ms\_threshold from Core manifest to client behavior (e.g., cap emits/day; warn on slow uploads).

* Respect allowed\_boot\_ids by rejecting commands referencing unknown kernels.

---

## **10\) Packaging, Signing & Distribution**

* Bundle IDs: dev.causable.mac (app), dev.causable.notary (XPC), dev.causable.sdk (framework).

* Code Signing: Developer ID Application; hardened runtime; entitlements as §2.

* Notarization: xcrun notarytool submit \--wait.

* Distribution: DMG with signed pkg; Sparkle appcast for updates.

---

## **11\) Telemetry & Observability**

* Local metrics (export on demand): outbox size, upload success rate, SSE lag, policy version.

* Healthchecks: notary.health() response includes SDK, policy, and last SSE event id.

* Debug panel: copyable diagnostics JSON.

---

## **12\) Reliability & Offline Behavior**

* Outbox survives reboots/crashes.

* Backoff with ceiling; jitter; network path monitoring to wake uploads.

* SSE auto‑resume using Last-Event-ID.

---

## **13\) Testing Strategy**

* Unit: SDK request signing, canonicalization, outbox state machine, SSE parser.

* Integration: Mock Cloud (local HTTP \+ SSE); enrollment; policy update.

* Energy: Power metrics with Instruments; ensure sampler stays in low usage bands.

* Security: Keychain/Enclave tests; sandbox entitlement lint.

---

## **14\) Roadmap to v1 GA**

* M1: SDK \+ Outbox \+ Ingest (CLI harness) ✅

* M2: XPC Notary Core \+ Enrollment \+ Key mgmt

* M3: Menu Bar Observer \+ Privacy controls

* M4: SSE Client \+ Policy application

* M5: Packaging, signing, notarization, auto‑update

* GA: SLOs met (see §15)

---

## **15\) SLOs & KPIs**

* Reliability: ≥ 99.9% successful ingest within 1h (rolling 7d).

* Latency: P95 ingest ≤ 1.2s (network path OK). SSE catch‑up ≤ 3s.

* Footprint: Idle CPU \< 1%; avg memory \< 150MB combined.

* Privacy: 100% Observer spans default visibility=private.

---

## **16\) CLI Companion (optional for devops)**

causable-macosctl enroll \--env prod

causable-macosctl push-span span.json

causable-macosctl diag \--dump

---

## **17\) Appendix — Sample Code**

### **17.1 Span Build & Send**

var span \= SpanEnvelope(/\* ... \*/)

let id \= try await client.ingest(span: span)

print("uploaded", id)

### **17.2 SSE Consumption**

for try await event in client.sseStream(params: \[URLQueryItem(name: "tenant\_id", value: tenant)\]) {

    // decode event, apply policy/cmd

}

### **17.3 Key Generation**

// Secure Enclave Ed25519 wrapper (or use CryptoKit Curve25519 then map)

---

## **18\) Risks & Mitigations**

* Window title sensitivity: Redaction map \+ user whitelist/blacklist; local‑only caching for raw titles.

* Key export: Disallow. Provide recovery via device re‑enrollment.

* Network blocks: Outbox \+ jitter; proxy support.

---

## **19\) Acceptance Criteria (v1)**

* End‑to‑end: enroll → emit activity → signed ingest → visible via SSE within 3s.

* Offline: 24h network cut → spans persist → drain upon reconnection.

* Security: No private key leaves device; all critical spans signed; sandbox enabled.

---

Deliverable: This spec is the authoritative blueprint to build the macOS Core System from scratch, interoperable with the existing LogLineOS (Postgres) Cloud.

—---

# **Causable Apps — Universal Blueprint (v1)**

Scope: Blueprint unificado para todos os apps do ecossistema Causable (VS Code, macOS Conductor, Web, CLI, bots). Parte do princípio de que o LogLineOS Cloud (Postgres \+ APIs) já existe. Define modelo de app, contratos universais, SDKs, segurança, publicação, telemetria, governança e roadmap de features.

---

## **0\) Objetivos**

* Padronizar como qualquer app observa, notaria e governa fatos via Ledger.

* Oferecer contratos universais (spans, SSE, ingest, fingerprints) e SDKs consistentes.

* Maximizar privacidade por padrão e auditabilidade por desenho.

Não‑objetivos

* Especificar UX final de cada app (detalhes são locais). Este doc cobre princípios e contratos.

---

## **1\) Taxonomia de Apps**

| Categoria | Exemplos | Papel | Canais |
| ----- | ----- | ----- | ----- |
| Instruments | VS Code Extension, CLI | Observer/Notary próximos ao código | IDE, terminal |
| Cockpits | macOS Conductor, Web Console | Governança, simulação, promoção | Desktop nativo / Web |
| Ambient Agents | Menu bar agent, Tray bots | Observer passivo \+ prompts | SO, notificações |
| Integrators | Git hooks, CI runners, Webhooks | Notary automatizado | CI/CD, SCM |
| Assistants | Chat agents, Telegram bot | Consulta/ação mediada | Chat, API |

---

## **2\) Modelo de App (Universal)**

graph TD

    A\[UI/Surface\] \--\> B\[Controller\]

    B \--\> C\[SDK Causable\]

    C \--\> D\[Ingest API\]

    C \--\> E\[SSE Timeline\]

    C \--\> F\[Manifests API\]

    C \--\> G\[Fingerprint API\]

    C \--\> H\[KMS/Keys\]

    C \--\> I\[Local Store\]

Componentes

* UI/Surface: plataforma‑específica (VS Code, AppKit, Web, CLI).

* Controller: orquestra fluxo Observer/Notary; aplica políticas locais.

* SDK Causable: cliente comum (assinatura, idempotência, SSE, outbox, canonicalização JSON).

* KMS/Keys: Ed25519 por dispositivo/instância; chaves nunca deixam o processo seguro.

* Local Store: outbox (persistência offline), cache de manifests, ETags.

---

## **3\) Contratos Universais**

### **3.1 Envelope de Span (v1)**

{

  "id": "uuid-v7",

  "entity\_type": "activity | codebase\_snapshot | execution | policy\_update | deploy | memory",

  "who": "app:\<surface\>@\<version\>",

  "did": "focused | analyzed | executed | promoted | deployed | recalled",

  "this": "device:\<uuid\> | workspace:\<id\> | span:\<id\>",

  "status": "complete | active | error",

  "input": {},

  "output": {},

  "metadata": {"tenant\_id":"...","owner\_id":"...","ts":"RFC3339","source":"\<app-id\>"},

  "visibility": "private | tenant | public",

  "digest": "b3:\<hex\>",

  "signature": {"algo":"ed25519","pubkey":"hex","sig":"hex"}

}

### **3.2 Ingest (idempotente)**

POST /api/spans

Authorization: Bearer \<token\>

X-Idempotency-Key: hmac(tenant\_id \+ digest)

Body: \<span JSON\>

→ 200 { id, digest, accepted\_at }

### **3.3 Timeline (SSE)**

GET /api/timeline/stream?tenant\_id=\<t\>\&since=\<ts\>\&filter=\<expr\>

Accept: text/event-stream

### **3.4 Manifests & Discovery**

GET /manifest/loglineos\_core\_manifest@v1

GET /manifest/causable\_apps\_manifest@v1

### **3.5 Architectural Fingerprint Service (AFS)**

GET  /api/fingerprint/{repo}

POST /api/fingerprint/{repo}

---

## **4\) Segurança, Privacidade e Políticas**

* Sandbox \+ Principle of Least Privilege em cada plataforma.

* Visibilidade: private por padrão (Observer); promoção explícita para tenant/public (Notary).

* Assinaturas: BLAKE3 \+ Ed25519; cosign opcional 2‑de‑N.

* RLS multitenant no servidor; validação cruzada de claims vs headers.

* Redação: listas de padrões sensíveis (títulos de janela, caminhos). Regra: evite dados brutos quando um resumo basta.

---

## **5\) SDK Causable (Idiomas & Targets)**

| Plataforma | Idioma | Forma |
| ----- | ----- | ----- |
| macOS/iOS | Swift (CryptoKit) | SwiftPM framework |
| Node/CLI | TypeScript (Node 18+) | npm pkg @causable/sdk |
| Web | TypeScript | ESM \+ WebCrypto |
| VS Code | TypeScript | @causable/sdk-vscode (wrap do core) |

Capacidades mínimas

* Canonicalização JSON (ordem estável), hashing BLAKE3, assinatura Ed25519.

* HTTP com backoff \+ jitter; X-Idempotency-Key.

* SSE client com Last-Event-ID.

* Outbox (persistência local); drain resiliente.

* Cache de manifests (ETag) \+ policy hooks locais.

---

## **6\) Ciclos de Vida do App**

1. Enroll: gera chave; POST /api/enroll com pubkey → device\_id, token.

2. Observe: coleta sinais locais; aplica redatores; enfileira spans activity.

3. Notarize: ações explícitas (deploy, publish, analyze) produzem spans assinados.

4. Govern: consome SSE policy\_update/command; aplica; emite execution/audit spans.

5. Update: mecanismo nativo (Sparkle, VS Code marketplace, npm dist-tags, web auto-update) com verificação de assinatura.

---

## **7\) Telemetria & KPIs (por App)**

* Confiabilidade: ≥99.9% ingest em 1h; taxa de erro \<1%.

* Latência: P95 ingest ≤1.2s; P95 SSE catch‑up ≤3s.

* Privacidade: 100% Observer → private por padrão; 0 vazamentos de dados brutos.

* Qualidade: taxa de falsos positivos do Guardian \<3%; aderência de políticas ≥95%.

---

## **8\) Distribuição e Assinatura**

* VS Code: pacote .vsix; assinatura \+ Marketplace; auto‑update.

* macOS: Developer ID \+ Hardened Runtime \+ notarização; Sparkle appcast.

* Web: Sub‑resource integrity (SRI) \+ CSP estrita; atualização por ETag.

* CLI: npm assinatura provedor \+ checksums; canal next/stable.

---

## **9\) Governança via Manifests**

* Core define kernels privilegiados, throttles, allowed\_boot\_ids.

* Apps lista app\_ids, entry points, dependências, defaults, interfaces.

* Fluxo de mudança: 2‑de‑N para alterações críticas; spans policy\_update e manifest\_signature.

---

## **10\) Extensibilidade (Hooks)**

* Pre‑Ingest: enriquecimento local (git, workspace, hostname redacted).

* Post‑Ingest: callbacks de confirmação (exibir toasts, atualizar badgets).

* AFS: provedores custom (monorepos multi‑linguagem).

* Policy Plugins: validadores locais (camada, naming, test density, docs density, smells comuns).

---

## **11\) Referências de Esquemas (mínimos)**

### **11.1** 

### **activity**

{"entity\_type":"activity","who":"observer:\<app\>@\<v\>","did":"focused","this":"device:\<uuid\>","status":"complete","input":{"app":"Xcode","window":"MyProject"},"visibility":"private"}

### **11.2** 

### **codebase\_snapshot**

{"entity\_type":"codebase\_snapshot","who":"guardian:\<app\>@\<v\>","did":"analyzed","this":"workspace:\<id\>","status":"complete","output":{"coherence\_score":92.4,"metrics":{"naming":97,"coverage":81,"docs":74,"layer\_violations":1}},"metadata":{"git":{"branch":"feature/x","sha":"abc123"}}}

### **11.3** 

### **execution**

{"entity\_type":"execution","who":"kernel:run\_code@v","did":"executed","this":"span:\<caller\>","status":"complete","input":{},"output":{"result":"ok","ms":120}}

---

## **12\) Roadmap Comum**

* R1 (Observer): viewer \+ ingest \+ SSE; privacidade forte.

* R2 (Notary): publicação de kernels/policies; seed publisher; deprecations.

* R3 (Guardian): AFS \+ análise contínua \+ codebase\_snapshot \+ badges.

* R4 (Govern): simulador de políticas; promoções com co‑assinatura.

---

## **13\) Critérios de Aceitação (por família)**

* Instrument: salvar arquivo → codebase\_snapshot no ledger ≤1s; UI atualiza badges em tempo real.

* Cockpit: promover policy → policy\_update \+ efeito observado em ≤5s nos clients.

* Ambient: alternar foco → activity com redaction; consumo de CPU \~0% idle.

---

## **14\) Riscos & Mitigações**

* Vazamento de contexto: redatores \+ listas de bloqueio locais \+ visibilidade private default.

* Inconsistência de SDKs: suite de testes de contrato (golden files de spans, SSE fixtures).

* Latência de rede: outbox \+ retries \+ compressão \+ edge endpoints.

---

## **15\) Apêndice — Estruturas de Projeto**

VS Code

extensions/guardian/

  package.json

  src/extension.ts

  src/controller.ts

  src/sdk.ts (wrap)

  media/\*

macOS (Conductor)

Conductor.app

  AppKit/SwiftUI UI

  XPC Notary

  CausableSDK.framework

CLI/Web

packages/sdk

packages/cli

apps/web-console

---

Resultado: Este blueprint fornece um contrato único para todos os apps do ecossistema Causable, garantindo interoperabilidade, segurança e evolução ordenada, independentemente da superfície (IDE, Desktop, Web, CLI, Bot).

—---

# **Causable Guardian — VS Code Extension Blueprint (v1, Greenfield)**

Scope: Especificação completa para construir do zero a extensão Causable Guardian para VS Code, alinhada ao Causable Apps — Universal Blueprint (v1) e interoperando com o LogLineOS Cloud (Postgres \+ APIs) já existente.

Papéis: Instrumento de Observer (sinais contínuos do workspace) e Notary (ações explícitas do dev). Guardian adiciona análise local e emite codebase\_snapshot com coherence\_score.

---

## **0\) Objetivos e Não‑objetivos**

Objetivos

* Visualizar timeline do ledger (SSE) no VS Code (painel lateral \+ toasts).

* Notarizar ações explícitas: publicar kernels/policies/NDJSON; registrar execuções.

* Analisar workspace local (CLI embutido/child process) e emitir codebase\_snapshot on‑save.

* Mostrar badges 🟢🟠🔴 por arquivo/pasta e um status bar meter de coherence\_score.

* Operar com privacidade por padrão (sem enviar fonte bruta).

Não‑objetivos

* Não substituir pipeline de CI; integração é opcional.

* Não armazenar segredos fora do Keychain do SO/credencial do VS Code.

---

## **1\) Arquitetura**

graph TD

  UI\[VS Code UI\] \--\> CTRL\[Extension Controller\]

  CTRL \--\> SDK\[@causable/sdk-vscode\]

  SDK \--\> OUTBOX\[(Outbox IndexedDB/FS)\]

  SDK \--\> KEYS\[Keychain/OS Keyring\]

  SDK \--\> API\[LogLineOS Cloud API\]

  SDK \--\> SSE\[SSE Timeline\]

  CTRL \--\> ANALYZER\[Local Analyzer (Node child proc)\]

Componentes

* Extension Controller: extension.ts — ativa/coordena comandos, eventos e views.

* SDK wrapper: @causable/sdk-vscode (TypeScript) — ingest, SSE, canonicalização, assinatura, outbox.

* Analyzer: @causable/cli (child process) ou módulo TS nativo (plugável) para análise local.

* Views: Timeline TreeView, Problems Diagnostics, Webview Dashboard, StatusBarItem, CodeLens/CodeActions.

---

## **2\) Estrutura do Projeto**

extensions/guardian/

  package.json

  tsconfig.json

  src/

    extension.ts

    controller.ts

    router.ts

    views/

      timelineView.ts

      dashboardWebview.ts

    features/

      observer.ts

      notary.ts

      guardian.ts

      publish.ts

      diagnostics.ts

      decorations.ts

      commands.ts

    infra/

      sdk.ts           // thin wrap of @causable/sdk

      outbox.ts        // fs-based queue

      sse.ts

      auth.ts          // enrollment/token mgmt

      settings.ts

      logging.ts

      telemetry.ts

      crypto.ts

      canonical.ts

      redaction.ts

    types/

      spans.ts

      messages.ts

      config.ts

  media/

    dashboard.html

    styles.css

    icon.svg

  test/

    unit/

    integration/

  README.md

  CHANGELOG.md

---

## **3\) Contribuições VS Code (package.json)**

{

  "name": "causable-guardian",

  "displayName": "Causable Guardian",

  "activationEvents": \[

    "onStartupFinished",

    "onLanguage:javascript",

    "onLanguage:typescript",

    "onCommand:causable.publishSpan",

    "onCommand:causable.deployKernel",

    "workspaceContains:\*\*/\*.ndjson"

  \],

  "contributes": {

    "commands": \[

      {"command": "causable.publishSpan", "title": "Causable: Publish Span (.ndjson)"},

      {"command": "causable.deployKernel", "title": "Causable: Deploy Kernel/Policy"},

      {"command": "causable.toggleObserver", "title": "Causable: Toggle Observer"}

    \],

    "views": {

      "explorer": \[

        {"id": "causableTimeline", "name": "Causable Timeline"}

      \]

    },

    "menus": {

      "editor/context": \[

        {"command": "causable.publishSpan", "group": "navigation@2"}

      \],

      "view/title": \[

        {"command": "causable.refreshTimeline", "when": "view \== causableTimeline"}

      \]

    },

    "configuration": {

      "properties": {

        "causable.endpoint": {"type": "string", "default": "https://api.causable.dev", "description": "Base URL do LogLineOS Cloud"},

        "causable.tenantId": {"type": "string", "default": "", "markdownDescription": "Tenant ID"},

        "causable.observer.enabled": {"type": "boolean", "default": true},

        "causable.guardian.onSave": {"type": "boolean", "default": true},

        "causable.redaction.patterns": {"type": "array", "items": {"type": "string"}, "default": \["password", "secret", "token"\], "markdownDescription": "Padrões a redigir nos sinais"}

      }

    },

    "codeActions": \[

      {"languages": \["javascript", "typescript"\], "kind": "quickfix.causable"}

    \]

  }

}

---

## **4\) Fluxos Principais**

### **4.1 Enrollment/Autenticação**

1. Ao ativar, checar device\_token no Keychain → se ausente, wizard: gerar chave Ed25519 (WebCrypto/Node) → POST /api/enroll → salvar token/tenant.

2. Buscar manifests core e apps (cache com ETag).

### **4.2 Observer (low‑sensitivity)**

* Eventos: onDidChangeActiveTextEditor, onDidChangeTextDocument (debounced), onDidChangeWindowState — coletar metadados não sensíveis (nome do arquivo, linguagem, duração no editor).

* Redação: aplicar redaction.patterns → remover paths/segredos.

* Queue: enfileirar activity spans no outbox → uploader com backoff.

### **4.3 Notary (ações explícitas)**

* Publish NDJSON: comando/ctx menu lê arquivo .ndjson, valida, assina e envia POST /api/spans.

* Deploy Kernel/Policy: CodeLens no topo de arquivos \*.kernel.\*/\*.policy.\* → confirmações \+ assinatura \+ ingest.

### **4.4 Guardian (inteligência local)**

* Análise on‑save: workspace.onWillSaveTextDocument → chamar Analyzer (child process) com lista de arquivos alterados.

* Resultado: coherence\_score \+ deviations\[\] → emitir codebase\_snapshot (sem fonte bruta).

* UX: StatusBarItem com score; Decorations inline; Diagnostics na aba Problems; ícones 🟢🟠🔴 no Explorer via FileDecorationProvider.

### **4.5 Timeline (SSE)**

* Conectar GET /api/timeline/stream?tenant\_id=...\&since=... com Last-Event-ID.

* Popular TreeDataProvider do Causable Timeline e toasts para eventos do usuário.

---

## **5\) Schemas de Spans (mínimos)**

### **5.1** 

### **activity**

{"entity\_type":"activity","who":"observer:vscode@1.0.0","did":"focused","this":"workspace:${id}","status":"complete","input":{"file":"src/app.ts","language":"typescript","ms":90000},"visibility":"private"}

### **5.2** 

### **codebase\_snapshot**

{"entity\_type":"codebase\_snapshot","who":"guardian:vscode@1.0.0","did":"analyzed","this":"workspace:${id}","status":"complete","output":{"coherence\_score":94.6,"metrics":{"naming":98,"coverage":80,"docs":75,"layer\_violations":0},"deviations":\[{"file":"src/app.ts","line":42,"severity":"warning","code":"missing\_jsdoc"}\]},"metadata":{"git":{"branch":"feature/x","sha":"abc123"}}}

### **5.3** 

### **execution**

###  **(deploy/publish)**

{"entity\_type":"execution","who":"notary:vscode@1.0.0","did":"published","this":"span:${ref}","status":"complete","input":{"type":"kernel","path":"packages/kernels/order.kernel.ts"},"output":{"result":"ok","id":"..."}}

---

## **6\) SDK** 

## **@causable/sdk-vscode**

##  **(API mínima)**

export interface SpanEnvelope { /\* schema v1 \*/ }

export interface ClientOpts { baseURL: string; tokenProvider:() \=\> Promise\<string\>; outboxPath:string; }

export class CausableClient {

  ingest(span: SpanEnvelope): Promise\<{id:string,digest:string}\>;

  sse(params: Record\<string,string\>): AsyncIterable\<{id:string,data:any,ts:string}\>;

  fetchManifest(name:string): Promise\<any\>;

}

export function canonicalize(span: SpanEnvelope): Uint8Array; // stable order

export function blake3(data: Uint8Array): Uint8Array;

export function signEd25519(digest: Uint8Array): Promise\<{pubkey:string,sig:string}\>;

Outbox: \~/.config/Causable/outbox (ou context.globalStorageUri) com \*.json \+ queue.db.

---

## **7\) UX & Componentes**

* Timeline TreeView: agrupado por dia → tipo de span → itens; ações de copiar ID/digest.

* Dashboard Webview: gauge de coherence\_score, lista de deviations, botão “Publish NDJSON”.

* Status Bar: $(shield) 94.6 com tooltip \+ click → dashboard.

* Decorations: margens coloridas por severidade.

* Diagnostics: DiagnosticCollection por arquivo.

* CodeLens: “Deploy Kernel/Policy”; QuickFixes para deviations comuns.

---

## **8\) Segurança & Privacidade**

* Sem fonte bruta: snapshots contêm métricas e diffs de estrutura, não conteúdo.

* Chaves: Ed25519 no keytar/OS keyring; nunca sair para o JS da webview.

* Idempotência: X-Idempotency-Key em todo POST; retries com jitter/limite.

* Config sensível: escopo machine e secretStorage para tokens.

---

## **9\) Desempenho & Offline**

* Análise: alvo P95 \< 300ms por arquivo salvo; lote para saves rápidos.

* Outbox: dreno resiliente; limite de memória; compressão opcional.

* SSE: reconexão com Last-Event-ID; buffer local de 1000 eventos.

---

## **10\) Testes**

* Unit: canonicalização, hashing, assinatura, outbox FSM, redaction.

* Integration: mock HTTP+SSE, enrollment, publish, analyzer roundtrip.

* E2E: vscode-test com workspace de exemplo; validação de badges e timeline.

* Perf: bench do analyzer (monorepo médio) e ingest.

---

## **11\) Build, Release & Telemetria**

* Build: vsce package \+ ovsx publish (Open VSX opcional).

* Assinatura: integridade do pacote; checksums publicadas.

* Channels: stable/insiders via tags.

* Telemetria: extension\_interaction (opt‑in), erros de ingest, latências; tudo em spans activity agregados.

---

## **12\) Roadmap v1 → v1.2**

* v1.0: Timeline \+ Publish NDJSON \+ Analyzer on‑save \+ StatusBar \+ Diagnostics.

* v1.1: CodeLens Deploy, QuickFixes automáticos, FileDecorations.

* v1.2: Policy Simulator (local), barras por pasta, integração com testes.

---

## **13\) KPIs & Aceitação**

* time‑to‑publish \< 20s (p95), publish\_failure\_rate \< 1%.

* snapshot\_latency ≤ 1s; analyzer\_p95 ≤ 300ms/arquivo; false\_positive \< 3%.

* Zero vazamento de fonte; 100% observer → private por padrão.

---

## **14\) Exemplos — Pseudocódigo**

On Save → Analyze → Emit

workspace.onWillSaveTextDocument(async (e) \=\> {

  if (\!cfg.guardian.onSave) return;

  const files \= \[e.document.fileName\];

  const r \= await analyzer.run(files);

  const span \= buildSnapshotSpan(r);

  await client.ingest(span);

  statusBar.update(r.coherence\_score);

});

Publish NDJSON

commands.registerCommand('causable.publishSpan', async (uri?: Uri) \=\> {

  const doc \= await workspace.openTextDocument(uri ?? window.activeTextEditor?.document?.uri\!);

  const json \= JSON.parse(doc.getText());

  validateSpan(json);

  await client.ingest(wrap(json));

  window.showInformationMessage('Published to ledger');

});

---

## **15\) Riscos & Mitigações**

* Ruído de análise: baseline por repo (AFS) \+ thresholds; learning mode.

* Latência de rede: outbox \+ compressão \+ endpoints regionais.

* Chaves: rotação simples; re‑enroll se comprometidas.

---

Resultado: Este blueprint é suficiente para implementar a extensão Causable Guardian do zero, interoperando com o LogLineOS Cloud e entregando valor imediato: visão do ledger, publicação de spans e verificação contínua de coerência arquitetural no fluxo do desenvolvedor.

---

---
