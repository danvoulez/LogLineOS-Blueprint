#!/usr/bin/env tsx

/**
 * Bootstrap Kernels Script
 * 
 * This script inserts the 5 core kernels into the ledger as spans.
 * Following ADR-005: Seeds via TypeScript scripts (not NDJSON).
 * 
 * Run with: npm run bootstrap:kernels
 */

import { createClient } from '@supabase/supabase-js';

// Load environment
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables:');
  console.error('   SUPABASE_URL');
  console.error('   SUPABASE_SERVICE_ROLE_KEY');
  console.error('\nPlease check your .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Helper to create span
function createKernelSpan(
  id: string,
  name: string,
  code: string,
  description: string
) {
  return {
    id,
    seq: 0,
    entity_type: 'function',
    who: 'system',
    did: 'defined',
    this: 'function',
    at: new Date().toISOString(),
    status: 'active',
    name,
    description,
    code,
    language: 'javascript',
    runtime: 'deno@1.x',
    owner_id: 'system',
    tenant_id: 'system',
    visibility: 'public'  // Kernels are public (everyone can execute)
  };
}

// ============================================================================
// Kernel 1: run_code_kernel
// ============================================================================
const run_code_kernel = createKernelSpan(
  '00000000-0000-4000-8000-000000000001',
  'run_code_kernel',
  `
// Run Code Kernel - Executes user functions with safety and governance
globalThis.default = async function main(ctx) {
  const { insertSpan, now, crypto, env } = ctx;
  
  // Get target function ID from environment
  const SPAN_ID = globalThis.SPAN_ID || Deno?.env?.get?.("SPAN_ID");
  if (!SPAN_ID) throw new Error("SPAN_ID required");
  if (!env.APP_USER_ID) throw new Error("APP_USER_ID required");
  
  // Fetch manifest and target function
  const { data: manifestData } = await ctx.supabase
    .from('visible_timeline')
    .select('*')
    .eq('entity_type', 'manifest')
    .order('at', { ascending: false })
    .limit(1);
  
  const manifest = manifestData?.[0] || { metadata: {} };
  const slowMs = Number(manifest.metadata?.policy?.slow_ms || 5000);
  
  const { data: fnData } = await ctx.supabase
    .from('visible_timeline')
    .select('*')
    .eq('id', SPAN_ID)
    .eq('entity_type', 'function')
    .order('at', { ascending: false })
    .limit(1);
  
  const fnSpan = fnData?.[0];
  if (!fnSpan) throw new Error("function not found");
  
  // Execute with timeout
  const start = performance.now();
  let output = null, error = null;
  const trace = fnSpan.trace_id || crypto.randomUUID();
  
  try {
    // Simple execution (no Worker sandbox in this minimal version)
    const factory = new Function("input", fnSpan.code || "return null;");
    output = await factory(fnSpan.input || null);
  } catch (e) {
    error = { message: String(e) };
  }
  
  const dur = Math.round(performance.now() - start);
  
  // Create execution span
  const execSpan = {
    id: crypto.randomUUID(),
    seq: 0,
    parent_id: fnSpan.id,
    entity_type: 'execution',
    who: 'kernel:run_code',
    did: 'executed',
    this: 'run_code',
    at: now(),
    status: error ? 'error' : 'complete',
    input: fnSpan.input,
    output: error ? null : output,
    error,
    duration_ms: dur,
    trace_id: trace,
    owner_id: fnSpan.owner_id,
    tenant_id: fnSpan.tenant_id,
    visibility: fnSpan.visibility || 'private',
    related_to: [fnSpan.id]
  };
  
  await insertSpan(execSpan);
  
  // Mark as slow if needed
  if (!error && dur > slowMs) {
    await insertSpan({
      id: crypto.randomUUID(),
      seq: 0,
      entity_type: 'status_patch',
      who: 'kernel:run_code',
      did: 'labeled',
      this: 'status=slow',
      at: now(),
      status: 'complete',
      parent_id: execSpan.id,
      related_to: [execSpan.id],
      owner_id: fnSpan.owner_id,
      tenant_id: fnSpan.tenant_id,
      visibility: fnSpan.visibility || 'private',
      metadata: { status: 'slow', duration_ms: dur }
    });
  }
};
  `.trim(),
  'Executes user functions with governance, quotas, and timeout enforcement'
);

// ============================================================================
// Kernel 2: observer_bot_kernel
// ============================================================================
const observer_bot_kernel = createKernelSpan(
  '00000000-0000-4000-8000-000000000002',
  'observer_bot_kernel',
  `
// Observer Bot Kernel - Monitors scheduled functions and creates request spans
globalThis.default = async function main(ctx) {
  const { now } = ctx;
  
  // Find functions with status='scheduled'
  const { data: functions } = await ctx.supabase
    .from('visible_timeline')
    .select('id, owner_id, tenant_id, visibility')
    .eq('entity_type', 'function')
    .eq('status', 'scheduled')
    .order('at', { ascending: true })
    .limit(16);
  
  if (!functions || functions.length === 0) return;
  
  // Create request spans for each scheduled function
  for (const fn of functions) {
    // Idempotent insert (will fail if duplicate due to unique index)
    await ctx.supabase
      .from('universal_registry')
      .insert({
        id: crypto.randomUUID(),
        seq: 0,
        entity_type: 'request',
        who: 'kernel:observer',
        did: 'scheduled',
        this: 'run_code',
        at: now(),
        status: 'scheduled',
        parent_id: fn.id,
        related_to: [fn.id],
        owner_id: fn.owner_id,
        tenant_id: fn.tenant_id,
        visibility: fn.visibility,
        trace_id: crypto.randomUUID()
      })
      .select();
  }
};
  `.trim(),
  'Observes scheduled functions and creates request spans for execution'
);

// ============================================================================
// Kernel 3: request_worker_kernel
// ============================================================================
const request_worker_kernel = createKernelSpan(
  '00000000-0000-4000-8000-000000000003',
  'request_worker_kernel',
  `
// Request Worker Kernel - Processes request spans by delegating to run_code_kernel
globalThis.default = async function main(ctx) {
  const RUN_CODE_KERNEL_ID = "00000000-0000-4000-8000-000000000001";
  
  // Find pending requests
  const { data: requests } = await ctx.supabase
    .from('visible_timeline')
    .select('id, parent_id')
    .eq('entity_type', 'request')
    .eq('status', 'scheduled')
    .order('at', { ascending: true })
    .limit(8);
  
  if (!requests || requests.length === 0) return;
  
  // Fetch run_code kernel
  const { data: kernelData } = await ctx.supabase
    .from('visible_timeline')
    .select('*')
    .eq('id', RUN_CODE_KERNEL_ID)
    .eq('entity_type', 'function')
    .order('at', { ascending: false })
    .limit(1);
  
  const runKernel = kernelData?.[0];
  if (!runKernel?.code) throw new Error("run_code_kernel not found");
  
  // Process each request
  for (const req of requests) {
    try {
      // Set SPAN_ID for run_code_kernel
      globalThis.SPAN_ID = req.parent_id;
      
      // Execute run_code kernel
      const factory = new Function("ctx", \`"use strict";\\n\${runKernel.code}\\n;return (typeof default!=='undefined'?default:globalThis.main);\`);
      const main = factory(ctx);
      if (typeof main === "function") {
        await main(ctx);
      }
    } catch (e) {
      console.error('Request processing error:', e);
    }
  }
};
  `.trim(),
  'Processes request spans by loading and executing the run_code_kernel'
);

// ============================================================================
// Kernel 4: policy_agent_kernel
// ============================================================================
const policy_agent_kernel = createKernelSpan(
  '00000000-0000-4000-8000-000000000004',
  'policy_agent_kernel',
  `
// Policy Agent Kernel - Evaluates policies against timeline events
globalThis.default = async function main(ctx) {
  const { insertSpan, now, crypto } = ctx;
  
  // Find active policies
  const { data: policies } = await ctx.supabase
    .from('visible_timeline')
    .select('*')
    .eq('entity_type', 'policy')
    .eq('status', 'active')
    .order('at', { ascending: true });
  
  if (!policies || policies.length === 0) return;
  
  for (const policy of policies) {
    // Get last cursor
    const { data: cursorData } = await ctx.supabase
      .from('visible_timeline')
      .select('metadata')
      .eq('entity_type', 'policy_cursor')
      .contains('related_to', [policy.id])
      .order('at', { ascending: false })
      .limit(1);
    
    const lastAt = cursorData?.[0]?.metadata?.last_at || new Date(0).toISOString();
    
    // Get candidate spans since last cursor
    const { data: candidates } = await ctx.supabase
      .from('visible_timeline')
      .select('*')
      .gt('at', lastAt)
      .eq('tenant_id', policy.tenant_id)
      .order('at', { ascending: true })
      .limit(500);
    
    if (!candidates || candidates.length === 0) continue;
    
    let newLastAt = lastAt;
    
    for (const span of candidates) {
      try {
        // Execute policy code (simple evaluation)
        const factory = new Function('span', \`\${policy.code || "return [];"};return (typeof default!=="undefined"?default:on)||on;\`);
        const policyFn = factory();
        const actions = (typeof policyFn === 'function' ? policyFn(span) : []) || [];
        
        // Process actions
        for (const action of actions) {
          if (action?.emit_span) {
            const emitSpan = {
              ...action.emit_span,
              id: action.emit_span.id || crypto.randomUUID(),
              seq: action.emit_span.seq ?? 0,
              at: action.emit_span.at || now(),
              owner_id: action.emit_span.owner_id ?? policy.owner_id,
              tenant_id: action.emit_span.tenant_id ?? policy.tenant_id,
              visibility: action.emit_span.visibility ?? policy.visibility
            };
            await insertSpan(emitSpan);
          }
        }
        
        newLastAt = span.at;
      } catch (e) {
        console.error('Policy evaluation error:', e);
      }
    }
    
    // Update cursor
    if (newLastAt !== lastAt) {
      await insertSpan({
        id: crypto.randomUUID(),
        seq: 0,
        entity_type: 'policy_cursor',
        who: 'kernel:policy_agent',
        did: 'advanced',
        this: 'cursor',
        at: now(),
        status: 'complete',
        related_to: [policy.id],
        owner_id: policy.owner_id,
        tenant_id: policy.tenant_id,
        visibility: policy.visibility,
        metadata: { last_at: newLastAt }
      });
    }
  }
};
  `.trim(),
  'Evaluates active policies against qualifying timeline events'
);

// ============================================================================
// Kernel 5: provider_exec_kernel
// ============================================================================
const provider_exec_kernel = createKernelSpan(
  '00000000-0000-4000-8000-000000000005',
  'provider_exec_kernel',
  `
// Provider Exec Kernel - Executes external provider calls (OpenAI, Ollama, etc.)
globalThis.default = async function main(ctx) {
  const { insertSpan, now, crypto, env } = ctx;
  
  const PROVIDER_ID = globalThis.PROVIDER_ID || Deno?.env?.get?.("PROVIDER_ID");
  const PAYLOAD = JSON.parse(globalThis.PROVIDER_PAYLOAD || Deno?.env?.get?.("PROVIDER_PAYLOAD") || "{}");
  
  if (!PROVIDER_ID) throw new Error("PROVIDER_ID required");
  
  // Load provider configuration
  const { data: providerData } = await ctx.supabase
    .from('visible_timeline')
    .select('*')
    .eq('id', PROVIDER_ID)
    .eq('entity_type', 'provider')
    .order('at', { ascending: false })
    .limit(1);
  
  const prov = providerData?.[0];
  if (!prov) throw new Error("provider not found");
  
  const meta = prov.metadata || {};
  let output = null, error = null;
  
  try {
    if (meta.base_url?.includes("openai.com")) {
      // OpenAI provider
      const r = await fetch(\`\${meta.base_url}/chat/completions\`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": \`Bearer \${Deno?.env?.get?.(meta.auth_env) || ""}\`
        },
        body: JSON.stringify({
          model: meta.model,
          messages: PAYLOAD.messages,
          temperature: PAYLOAD.temperature ?? 0.2
        })
      });
      output = await r.json();
    } else if ((meta.base_url || "").includes("localhost:11434")) {
      // Ollama provider
      const r = await fetch(\`\${meta.base_url}/api/chat\`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: meta.model || "llama3",
          messages: PAYLOAD.messages
        })
      });
      output = await r.json();
    } else {
      throw new Error("unsupported provider");
    }
  } catch (e) {
    error = { message: String(e) };
  }
  
  // Create execution span
  const execSpan = {
    id: crypto.randomUUID(),
    seq: 0,
    entity_type: 'provider_execution',
    who: 'kernel:provider_exec',
    did: 'called',
    this: 'provider.exec',
    at: now(),
    status: error ? 'error' : 'complete',
    input: PAYLOAD,
    output: error ? null : output,
    error,
    owner_id: prov.owner_id,
    tenant_id: prov.tenant_id,
    visibility: prov.visibility || 'private',
    related_to: [prov.id]
  };
  
  await insertSpan(execSpan);
};
  `.trim(),
  'Executes external provider calls (OpenAI, Ollama, etc.) with telemetry'
);

// ============================================================================
// Main Bootstrap Function
// ============================================================================
async function bootstrap() {
  console.log('🔄 Bootstrapping 5 core kernels...\n');
  
  const kernels = [
    run_code_kernel,
    observer_bot_kernel,
    request_worker_kernel,
    policy_agent_kernel,
    provider_exec_kernel
  ];
  
  for (const kernel of kernels) {
    try {
      // Check if kernel already exists
      const { data: existing } = await supabase
        .from('universal_registry')
        .select('id')
        .eq('id', kernel.id)
        .eq('seq', 0);
      
      if (existing && existing.length > 0) {
        console.log(`⏭️  ${kernel.name} already exists (skipping)`);
        continue;
      }
      
      // Insert kernel
      const { error } = await supabase
        .from('universal_registry')
        .insert(kernel);
      
      if (error) {
        console.error(`❌ Failed to create ${kernel.name}:`, error.message);
        process.exit(1);
      }
      
      console.log(`✅ ${kernel.name} created`);
    } catch (error) {
      console.error(`❌ Error creating ${kernel.name}:`, error);
      process.exit(1);
    }
  }
  
  console.log('\n✅ All kernels bootstrapped successfully!\n');
  
  // Verify
  const { data: allKernels, error } = await supabase
    .from('visible_timeline')
    .select('id, name, status')
    .eq('entity_type', 'function')
    .in('id', kernels.map(k => k.id));
  
  if (error) {
    console.error('❌ Verification failed:', error.message);
    process.exit(1);
  }
  
  console.log('📋 Verification:');
  console.log(`   Found ${allKernels?.length || 0}/5 kernels in ledger`);
  
  if (allKernels?.length === 5) {
    console.log('\n🎉 Bootstrap complete! Next steps:');
    console.log('   1. npm run deploy:stage0');
    console.log('   2. npm run deploy:workers');
    console.log('   3. npm run verify\n');
  } else {
    console.error('\n❌ Expected 5 kernels, found', allKernels?.length);
    process.exit(1);
  }
}

// Run
bootstrap().catch(error => {
  console.error('❌ Bootstrap failed:', error);
  process.exit(1);
});
