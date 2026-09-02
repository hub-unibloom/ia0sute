// Supabase Edge Function: 'entrar'
// Compatível com Deno Runtime do Supabase Edge Functions (Web Dashboard Deploy)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

const SUPABASE_URL = "https://tcxhuryqrzidvrltjhiz.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Xz1PSjOLImkMDkF3waRw1g_EAl1DiZ1";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const nomeCopiloto = body?.name || body?.nome || "Copiloto I.A. via Edge Function";

    // Gerador de API Key sk_ia_...
    const randomBytes = crypto.getRandomValues(new Uint8Array(16));
    const hexString = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    const apiKey = `sk_ia_${hexString}`;
    const prefix = apiKey.substring(0, 8);

    // Hash SHA-256
    const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
    const apiKeyHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Salva no banco de dados
    const { data, error } = await supabase
      .from('ia_copiloto')
      .insert([
        {
          nome: nomeCopiloto,
          api_key_hash: apiKeyHash,
          api_key_prefix: prefix,
          ativo: true,
          metadata: { origem: 'supabase_edge_function_entrar', body }
        }
      ])
      .select();

    if (error) {
      console.error('Erro ao salvar no banco:', error);
    }

    return new Response(
      JSON.stringify({
        success: true,
        mensagem: "Copiloto registrado com sucesso",
        api_key: apiKey,
        api_key_prefix: prefix,
        copiloto: data
      }),
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
