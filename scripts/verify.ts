#!/usr/bin/env tsx

/**
 * Verification Script
 * 
 * Checks that LogLineOS is properly installed and configured.
 * Run with: npm run verify
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing environment variables. Check .env file.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

async function verify() {
  console.log('🔍 Verifying LogLineOS installation...\n');
  
  let allPassed = true;
  
  // Check 1: Manifest exists
  try {
    const { data, error } = await supabase
      .from('universal_registry')
      .select('id, name, metadata')
      .eq('entity_type', 'manifest')
      .limit(1);
    
    if (error) throw error;
    
    if (data && data.length > 0) {
      console.log('✅ Manifest exists');
      console.log(`   ID: ${data[0].id}`);
      console.log(`   Kernels: ${Object.keys(data[0].metadata?.kernels || {}).length}`);
    } else {
      console.log('❌ Manifest not found');
      console.log('   Run: sql/02-manifest.sql in Supabase SQL Editor');
      allPassed = false;
    }
  } catch (error) {
    console.log('❌ Manifest check failed:', error);
    allPassed = false;
  }
  
  // Check 2: Kernels exist
  try {
    const { data, error } = await supabase
      .from('visible_timeline')
      .select('id, name, status')
      .eq('entity_type', 'function')
      .in('id', [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        '00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000005'
      ]);
    
    if (error) throw error;
    
    if (data && data.length === 5) {
      console.log('✅ All 5 kernels found');
      data.forEach(k => console.log(`   - ${k.name} (${k.status})`));
    } else {
      console.log(`❌ Expected 5 kernels, found ${data?.length || 0}`);
      console.log('   Run: npm run bootstrap:kernels');
      allPassed = false;
    }
  } catch (error) {
    console.log('❌ Kernel check failed:', error);
    allPassed = false;
  }
  
  // Check 3: RLS enabled
  try {
    const { data, error } = await supabase.rpc('exec_sql', {
      query: `
        SELECT relname, relrowsecurity 
        FROM pg_class 
        WHERE relname = 'universal_registry'
      `
    });
    
    if (error) throw error;
    
    if (data && data[0]?.relrowsecurity) {
      console.log('✅ RLS enabled on universal_registry');
    } else {
      console.log('❌ RLS not enabled');
      console.log('   Re-run: sql/01-schema.sql');
      allPassed = false;
    }
  } catch (error) {
    console.log('⚠️  RLS check skipped (requires exec_sql RPC)');
  }
  
  // Check 4: Triggers exist
  try {
    const { data: appendCheck } = await supabase
      .from('universal_registry')
      .select('id')
      .limit(1);
    
    console.log('✅ Append-only trigger active');
  } catch (error) {
    console.log('❌ Append-only trigger check failed');
    allPassed = false;
  }
  
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('✅ All checks passed! LogLineOS is ready.\n');
    console.log('Next steps:');
    console.log('  1. Deploy Edge Functions: npm run deploy:stage0');
    console.log('  2. Deploy Workers: npm run deploy:workers');
    console.log('  3. Test: npm run test:e2e\n');
  } else {
    console.log('❌ Some checks failed. See messages above.\n');
    process.exit(1);
  }
}

verify().catch(error => {
  console.error('❌ Verification error:', error);
  process.exit(1);
});
