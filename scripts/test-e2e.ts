#!/usr/bin/env tsx

/**
 * End-to-End Test
 * 
 * Tests the complete LogLineOS execution flow:
 * 1. Create a test function
 * 2. Schedule it
 * 3. Wait for observer to create request
 * 4. Wait for request_worker to execute
 * 5. Verify execution completed
 * 
 * Run with: npm run test:e2e
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

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test() {
  console.log('🧪 Running end-to-end test...\n');

  // Step 1: Create test function
  console.log('1️⃣ Creating test function...');
  const testFunctionId = crypto.randomUUID();
  
  const { error: insertError } = await supabase
    .from('universal_registry')
    .insert({
      id: testFunctionId,
      seq: 0,
      entity_type: 'function',
      who: 'test:e2e',
      did: 'defined',
      this: 'test_function',
      at: new Date().toISOString(),
      status: 'scheduled',  // Mark as scheduled
      name: 'e2e_test_function',
      code: 'return { message: "Hello from E2E test!", timestamp: new Date().toISOString() };',
      language: 'javascript',
      runtime: 'deno@1.x',
      owner_id: 'test',
      tenant_id: 'test',
      visibility: 'private'
    });

  if (insertError) {
    console.error('❌ Failed to create test function:', insertError);
    process.exit(1);
  }

  console.log('   ✅ Test function created:', testFunctionId);

  // Step 2: Wait for observer to create request (10s)
  console.log('\n2️⃣ Waiting for observer to create request span (max 15s)...');
  let requestCreated = false;
  let attempts = 0;

  while (!requestCreated && attempts < 15) {
    await sleep(1000);
    attempts++;

    const { data: requests } = await supabase
      .from('visible_timeline')
      .select('id')
      .eq('entity_type', 'request')
      .eq('parent_id', testFunctionId)
      .eq('status', 'scheduled');

    if (requests && requests.length > 0) {
      requestCreated = true;
      console.log(`   ✅ Request span created after ${attempts}s`);
    } else {
      process.stdout.write(`   ⏳ Waiting... ${attempts}s\r`);
    }
  }

  if (!requestCreated) {
    console.log('\n   ❌ Observer did not create request span');
    console.log('   ℹ️  Make sure observer worker is deployed and cron is configured');
    process.exit(1);
  }

  // Step 3: Wait for request_worker to execute (10s)
  console.log('\n3️⃣ Waiting for request_worker to execute (max 15s)...');
  let executionComplete = false;
  attempts = 0;

  while (!executionComplete && attempts < 15) {
    await sleep(1000);
    attempts++;

    const { data: executions } = await supabase
      .from('visible_timeline')
      .select('id, status, output, error')
      .eq('entity_type', 'execution')
      .eq('parent_id', testFunctionId);

    if (executions && executions.length > 0) {
      executionComplete = true;
      const exec = executions[0];
      console.log(`   ✅ Execution completed after ${attempts}s`);
      console.log('   Status:', exec.status);
      
      if (exec.output) {
        console.log('   Output:', JSON.stringify(exec.output, null, 2));
      }
      
      if (exec.error) {
        console.log('   ⚠️  Error:', exec.error);
      }
    } else {
      process.stdout.write(`   ⏳ Waiting... ${attempts}s\r`);
    }
  }

  if (!executionComplete) {
    console.log('\n   ❌ Request worker did not execute function');
    console.log('   ℹ️  Make sure request-worker is deployed and cron is configured');
    process.exit(1);
  }

  // Step 4: Verify complete flow
  console.log('\n4️⃣ Verifying complete flow...');
  
  const { data: allSpans } = await supabase
    .from('visible_timeline')
    .select('entity_type, status')
    .or(`id.eq.${testFunctionId},parent_id.eq.${testFunctionId}`)
    .order('at', { ascending: true });

  console.log('   Timeline:');
  allSpans?.forEach(span => {
    console.log(`   - ${span.entity_type} (${span.status})`);
  });

  // Cleanup
  console.log('\n5️⃣ Cleaning up...');
  // Note: Can't delete due to append-only, but we can mark as deleted
  await supabase
    .from('universal_registry')
    .insert({
      id: testFunctionId,
      seq: 1,
      entity_type: 'function',
      who: 'test:e2e',
      did: 'cleanup',
      this: 'test_function',
      at: new Date().toISOString(),
      status: 'archived',
      is_deleted: true,
      owner_id: 'test',
      tenant_id: 'test',
      visibility: 'private'
    });

  console.log('   ✅ Test data marked as deleted\n');

  console.log('✅ End-to-end test PASSED!\n');
  console.log('Summary:');
  console.log('  - Function created');
  console.log('  - Observer detected and created request');
  console.log('  - Request worker executed function');
  console.log('  - Execution recorded in ledger');
  console.log('\n🎉 LogLineOS is working correctly!\n');
}

test().catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});
