// Supabase Edge Function: processar-payload
// Recebe payloads decodificados de I.A., grava no banco de dados e calcula a próxima etapa.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { payload, url_origem } = await req.json();

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Registra a sessão / payload no Supabase
    const { data, error } = await supabase
      .from('requisicoes_ia')
      .insert([
        {
          payload_raw: payload,
          url_origem: url_origem,
          etapa_calculada: payload?.etapa ?? 1,
          criado_em: new Date().toISOString()
        }
      ])
      .select();

    if (error) throw error;

    return new Response(
      JSON.stringify({ success: true, registro: data }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
    );

  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ success: false, error: errorMsg }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
    );
  }
});
