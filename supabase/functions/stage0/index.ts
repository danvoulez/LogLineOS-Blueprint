/**
 * Stage-0 Bootstrap Loader
 * 
 * Immutable loader that:
 * 1. Fetches whitelisted function from ledger by ID
 * 2. Verifies hash/signature (if enabled)
 * 3. Executes with minimal context
 * 4. Records boot_event for audit
 * 
 * Following Blueprint specification and ADR-002 (Hybrid DB client approach)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { blake3 } from 'https://esm.sh/@noble/hashes@1.4.0/blake3';
import * as ed from 'https://esm.sh/@noble/ed25519@2.1.0';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get environment variables
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const SIGNING_KEY_HEX = Deno.env.get('SIGNING_KEY_HEX') || undefined;

    // Parse request
    const { function_id, env: userEnv } = await req.json();
    
    if (!function_id) {
      return new Response(
        JSON.stringify({ error: 'function_id required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Create Supabase client
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Helper functions
    const hex = (u8: Uint8Array) => Array.from(u8).map(b => b.toString(16).padStart(2, "0")).join("");
    const toU8 = (h: string) => Uint8Array.from(h.match(/.{1,2}/g)!.map(x => parseInt(x, 16)));
    const now = () => new Date().toISOString();

    // Fetch latest manifest
    const { data: manifestData } = await supabase
      .from('visible_timeline')
      .select('*')
      .eq('entity_type', 'manifest')
      .order('at', { ascending: false })
      .limit(1);

    const manifest = manifestData?.[0] || { metadata: {} };
    const allowedIds = (manifest.metadata?.allowed_boot_ids || []) as string[];

    // Verify function_id is whitelisted
    if (!allowedIds.includes(function_id)) {
      return new Response(
        JSON.stringify({ error: 'function_id not in manifest whitelist' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch function from ledger
    const { data: fnData } = await supabase
      .from('visible_timeline')
      .select('*')
      .eq('id', function_id)
      .eq('entity_type', 'function')
      .order('at', { ascending: false })
      .limit(1);

    const fnSpan = fnData?.[0];
    if (!fnSpan) {
      return new Response(
        JSON.stringify({ error: 'function not found in ledger' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Verify hash/signature if required
    if (manifest.metadata?.features?.signatures_required) {
      const clone = structuredClone(fnSpan);
      delete clone.signature;
      delete clone.curr_hash;
      
      const msg = new TextEncoder().encode(JSON.stringify(clone, Object.keys(clone).sort()));
      const computedHash = hex(blake3(msg));

      if (fnSpan.curr_hash && fnSpan.curr_hash !== computedHash) {
        return new Response(
          JSON.stringify({ error: 'hash mismatch' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      if (fnSpan.signature && fnSpan.public_key) {
        const ok = await ed.verify(
          toU8(fnSpan.signature),
          toU8(computedHash),
          toU8(fnSpan.public_key)
        );
        
        if (!ok) {
          return new Response(
            JSON.stringify({ error: 'invalid signature' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }
    }

    // Record boot event
    await supabase.from('universal_registry').insert({
      id: crypto.randomUUID(),
      seq: 0,
      entity_type: 'boot_event',
      who: 'edge:stage0',
      did: 'booted',
      this: 'stage0',
      at: now(),
      status: 'complete',
      input: {
        boot_id: function_id,
        env: { user: userEnv?.APP_USER_ID, tenant: userEnv?.APP_TENANT_ID }
      },
      owner_id: fnSpan.owner_id,
      tenant_id: fnSpan.tenant_id,
      visibility: fnSpan.visibility || 'private',
      related_to: [function_id]
    });

    // Create execution context
    const insertSpan = async (span: any) => {
      await supabase.from('universal_registry').insert(span);
    };

    const ctx = {
      env: {
        APP_USER_ID: userEnv?.APP_USER_ID || 'edge:stage0',
        APP_TENANT_ID: userEnv?.APP_TENANT_ID || 'system',
        SIGNING_KEY_HEX
      },
      supabase,
      insertSpan,
      now,
      crypto: {
        blake3,
        ed25519: ed,
        hex,
        toU8,
        randomUUID: crypto.randomUUID
      }
    };

    // Execute function code
    const factory = new Function(
      "ctx",
      `"use strict";\n${String(fnSpan.code || "")}\n;return (typeof default!=='undefined'?default:globalThis.main);`
    );

    const main = factory(ctx);
    if (typeof main !== "function") {
      return new Response(
        JSON.stringify({ error: 'kernel has no default/main export' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Run kernel
    await main(ctx);

    return new Response(
      JSON.stringify({
        ok: true,
        function_id,
        executed_at: now()
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Stage-0 error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
