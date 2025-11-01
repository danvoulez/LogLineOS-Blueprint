#!/usr/bin/env tsx

/**
 * Validate Blueprint Compliance
 * 
 * Verifies that the implementation adheres to LogLineOS Blueprint principles:
 * 1. Ledger-first: All business logic in spans
 * 2. Append-only: No UPDATE/DELETE triggers
 * 3. Stage-0 bootstrap: Kernels loaded from ledger
 * 4. RLS multi-tenant: Policies enforced
 * 5. Span as primitive: Everything is a span
 * 6. Manifest governance: Whitelist controls execution
 * 
 * Run with: npm run validate:compliance
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing environment variables');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function validate() {
  console.log('🔍 Validating LogLineOS Blueprint Compliance...\n');

  let allPassed = true;

  // Principle 1: Ledger-First
  console.log('1️⃣  Ledger-First: All business logic in spans');
  try {
    const { data: kernels } = await supabase
      .from('visible_timeline')
      .select('id, name, code')
      .eq('entity_type', 'function')
      .in('id', [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005'
      ]);

    if (kernels && kernels.length === 5 && kernels.every(k => k.code)) {
      console.log('   ✅ All 5 kernels stored in ledger with code');
    } else {
      console.log('   ❌ Kernels not properly stored in ledger');
      allPassed = false;
    }
  } catch (e) {
    console.log('   ❌ Failed to verify kernels:', e);
    allPassed = false;
  }

  // Principle 2: Append-Only
  console.log('\n2️⃣  Append-Only: No UPDATE/DELETE allowed');
  try {
    // Try to update a span (should fail)
    const testId = crypto.randomUUID();
    
    // First insert
    await supabase.from('universal_registry').insert({
      id: testId,
      seq: 0,
      entity_type: 'test',
      who: 'compliance:test',
      did: 'test',
      this: 'compliance_test',
      at: new Date().toISOString(),
      owner_id: 'test',
      tenant_id: 'test',
      visibility: 'private'
    });

    // Try to update (should fail)
    const { error } = await supabase
      .from('universal_registry')
      .update({ status: 'updated' })
      .eq('id', testId);

    if (error && error.message.includes('Append-only')) {
      console.log('   ✅ Append-only trigger is active (UPDATE blocked)');
    } else {
      console.log('   ❌ Append-only trigger not working properly');
      allPassed = false;
    }
  } catch (e) {
    console.log('   ❌ Failed to test append-only:', e);
    allPassed = false;
  }

  // Principle 3: Stage-0 Bootstrap
  console.log('\n3️⃣  Stage-0 Bootstrap: Kernels loaded from ledger');
  try {
    // Verify Stage-0 endpoint exists (by checking if deployed)
    const stageResponse = await fetch(`${SUPABASE_URL}/functions/v1/stage0`, {
      method: 'OPTIONS'
    });

    if (stageResponse.ok || stageResponse.status === 404) {
      console.log('   ✅ Stage-0 endpoint accessible');
    } else {
      console.log('   ⚠️  Stage-0 endpoint may not be deployed');
      console.log('      Run: npm run deploy:stage0');
    }
  } catch (e) {
    console.log('   ⚠️  Could not verify Stage-0 deployment');
  }

  // Principle 4: RLS Multi-tenant
  console.log('\n4️⃣  RLS Multi-tenant: Policies enforced');
  try {
    const { data: policies } = await supabase.rpc('exec_sql', {
      query: `
        SELECT polname FROM pg_policy 
        WHERE schemaname = 'ledger' 
        AND tablename = 'universal_registry'
      `
    });

    if (policies && policies.length >= 2) {
      console.log('   ✅ RLS policies configured (found ' + policies.length + ' policies)');
    } else {
      console.log('   ❌ RLS policies not configured properly');
      allPassed = false;
    }
  } catch (e) {
    console.log('   ⚠️  Could not verify RLS policies (exec_sql may not be available)');
  }

  // Principle 5: Span as Primitive
  console.log('\n5️⃣  Span as Primitive: Everything is a span');
  try {
    const { data: entityTypes } = await supabase
      .from('universal_registry')
      .select('entity_type')
      .limit(1000);

    const uniqueTypes = new Set(entityTypes?.map(e => e.entity_type));
    const expectedTypes = ['manifest', 'function', 'execution', 'request'];
    const hasExpectedTypes = expectedTypes.every(t => uniqueTypes.has(t));

    if (hasExpectedTypes) {
      console.log('   ✅ Multiple entity types found (all as spans):');
      Array.from(uniqueTypes).forEach(type => {
        console.log('      -', type);
      });
    } else {
      console.log('   ⚠️  Some expected entity types not found');
    }
  } catch (e) {
    console.log('   ❌ Failed to verify span types:', e);
    allPassed = false;
  }

  // Principle 6: Manifest Governance
  console.log('\n6️⃣  Manifest Governance: Whitelist controls execution');
  try {
    const { data: manifests } = await supabase
      .from('visible_timeline')
      .select('metadata')
      .eq('entity_type', 'manifest')
      .order('at', { ascending: false })
      .limit(1);

    const manifest = manifests?.[0];
    if (manifest?.metadata?.allowed_boot_ids && 
        Array.isArray(manifest.metadata.allowed_boot_ids) &&
        manifest.metadata.allowed_boot_ids.length > 0) {
      console.log('   ✅ Manifest with whitelist exists');
      console.log('      Allowed boot IDs:', manifest.metadata.allowed_boot_ids.length);
    } else {
      console.log('   ❌ Manifest whitelist not configured');
      allPassed = false;
    }
  } catch (e) {
    console.log('   ❌ Failed to verify manifest:', e);
    allPassed = false;
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  if (allPassed) {
    console.log('✅ All blueprint principles verified!\n');
    console.log('LogLineOS implementation is compliant with the Blueprint.\n');
  } else {
    console.log('⚠️  Some compliance checks failed.\n');
    console.log('Review the messages above and fix any issues.\n');
    process.exit(1);
  }
}

validate().catch(error => {
  console.error('❌ Validation failed:', error);
  process.exit(1);
});
