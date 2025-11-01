/**
 * Observer Worker
 * 
 * Periodically invoked by pg_cron to execute the observer_bot_kernel.
 * The kernel monitors scheduled functions and creates request spans.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const OBSERVER_KERNEL_ID = '00000000-0000-4000-8000-000000000002';

    // Call Stage-0 to execute observer kernel
    const response = await fetch(`${SUPABASE_URL}/functions/v1/stage0`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      },
      body: JSON.stringify({
        function_id: OBSERVER_KERNEL_ID,
        env: {
          APP_USER_ID: 'worker:observer',
          APP_TENANT_ID: 'system'
        }
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || 'Stage-0 execution failed');
    }

    return new Response(
      JSON.stringify({ ok: true, result }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Observer worker error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
