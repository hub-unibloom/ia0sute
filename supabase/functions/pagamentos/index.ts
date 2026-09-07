import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.48.0";

// --- TIPAGENS BASEADAS NO pix.json ---
interface Pessoa {
  nome: string;
  cpf?: string;
  cnpj?: string;
}

interface CobSolicitada {
  calendario: { expiracao: number };
  devedor?: Pessoa;
  valor: { original: string };
  chave: string;
  solicitacaoPagador?: string;
}

interface WebhookPixItem {
  txid: string;
  valor: string;
  horario: string;
  endToEndId: string;
  pagador?: string;
}

interface WebhookCallback {
  txid?: string;
  valor?: string;
  status?: string;
  pix?: WebhookPixItem[];
  chave?: string;
  infoPagador?: string;
}

// --- CONFIGURAÇÃO GLOBAL ---
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getC6Config() {
  return {
    clientId: Deno.env.get("C6_CLIENT_ID") || "",
    clientSecret: Deno.env.get("C6_CLIENT_SECRET") || "",
    pixKey: Deno.env.get("C6_PIX_KEY") || "",
    certPem: Deno.env.get("C6_CERT_PEM") || "",
    keyPem: Deno.env.get("C6_KEY_PEM") || "",
    env: Deno.env.get("C6_ENV") || "sandbox",
  };
}

function getBaseUrl(env: string) {
  return env === "production" ? "https://baas-api.c6bank.info" : "https://baas-api-sandbox.c6bank.info";
}

function getSupabaseClient() {
  const url = Deno.env.get("SUPABASE_URL") || "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  return createClient(url, key);
}

// --- FUNÇÃO DE AUTENTICAÇÃO (MTLS) ---
async function getC6Token(config: ReturnType<typeof getC6Config>) {
  if (!config.certPem || !config.keyPem) {
    throw new Error("Certificados MTLS ausentes.");
  }

  const mtlsClient = Deno.createHttpClient({
    cert: config.certPem,
    key: config.keyPem,
  });

  const authUrl = `${getBaseUrl(config.env)}/v1/auth`;
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "client_credentials"
  });

  const tokenResponse = await fetch(authUrl, {
    method: "POST",
    client: mtlsClient,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });

  if (!tokenResponse.ok) {
    const errorText = await tokenResponse.text();
    throw new Error(`Falha na autenticação C6 Bank: ${errorText}`);
  }

  const data = await tokenResponse.json();
  return { accessToken: data.access_token, mtlsClient };
}

// --- ROTEADOR ---
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url = new URL(req.url);
  const path = url.pathname;

  try {
    const config = getC6Config();
    const supabase = getSupabaseClient();

    // ==========================================
    // ROTA 1: CRIAR COBRANÇA PIX (COB)
    // ==========================================
    if (path.endsWith("/cob") && req.method === "POST") {
      const { valor, devedor, descricao, comanda_id } = await req.json();

      if (!valor || !devedor || !devedor.nome || !devedor.cpf_cnpj || !comanda_id) {
        return new Response(JSON.stringify({ error: "Faltam parâmetros obrigatórios (valor, devedor.nome, devedor.cpf_cnpj, comanda_id)" }), { status: 400, headers: corsHeaders });
      }

      const { accessToken, mtlsClient } = await getC6Token(config);
      
      const documentoSanitizado = devedor.cpf_cnpj.replace(/\D/g, "");
      let pessoa: Pessoa = { nome: devedor.nome };
      if (documentoSanitizado.length === 11) pessoa.cpf = documentoSanitizado;
      else if (documentoSanitizado.length === 14) pessoa.cnpj = documentoSanitizado;

      const cobPayload: CobSolicitada = {
        calendario: { expiracao: 86400 },
        valor: { original: parseFloat(valor).toFixed(2) },
        chave: config.pixKey,
        devedor: pessoa,
        solicitacaoPagador: descricao || "Pagamento Sensacional"
      };

      const cobUrl = `${getBaseUrl(config.env)}/v2/pix/cob`;
      const cobResponse = await fetch(cobUrl, {
        method: "POST",
        client: mtlsClient,
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(cobPayload)
      });

      if (!cobResponse.ok) throw new Error(`Falha ao criar COB: ${await cobResponse.text()}`);
      
      const cobData = await cobResponse.json();

      // Gravar na tabela 'pagamento' associada à 'comanda' (Conforme banco.sql)
      const { data: pagamentoInsert, error: dbError } = await supabase
        .from("pagamento")
        .insert({
          comanda_id: comanda_id,
          metodo: "pix",
          status: "pendente",
          valor: parseFloat(valor),
          moeda: "BRL",
          gateway: "c6bank",
          gateway_pagamento_id: cobData.txid,
          metadados: {
            location: cobData.location,
            chave_pix: config.pixKey,
            emv: cobData.pixCopiaECola || null
          }
        })
        .select()
        .single();

      if (dbError) throw new Error(`Erro ao salvar pagamento no banco: ${dbError.message}`);

      // Atualizar status da comanda para 'aguardando_pagamento'
      await supabase.from("comanda").update({ status: "aguardando_pagamento" }).eq("id", comanda_id);

      return new Response(JSON.stringify({
        success: true,
        pagamento_id: pagamentoInsert.id,
        txid: cobData.txid,
        location: cobData.location,
        pix_emv: cobData.pixCopiaECola || null
      }), { status: 201, headers: corsHeaders });
    }

    // ==========================================
    // ROTA 2: RECEPÇÃO DE WEBHOOK (Callback C6)
    // ==========================================
    if (path.endsWith("/webhook") && req.method === "POST") {
      const payload: WebhookCallback = await req.json();
      const pixList = payload.pix || [];
      const resultados = [];

      // O banco envia uma lista de PIXs recebidos
      for (const pix of pixList) {
        if (!pix.txid) continue;

        // 1. Busca o pagamento original no banco para checar o valor
        const { data: pagamentoExistente, error: errorBusca } = await supabase
          .from("pagamento")
          .select("id, valor, status, comanda_id")
          .eq("gateway_pagamento_id", pix.txid)
          .eq("gateway", "c6bank")
          .single();

        if (errorBusca || !pagamentoExistente) {
          resultados.push({ txid: pix.txid, erro: "Pagamento não encontrado no banco de dados." });
          continue;
        }

        if (pagamentoExistente.status === "pago") {
          resultados.push({ txid: pix.txid, aviso: "Pagamento já constava como pago." });
          continue;
        }

        // 2. Aceita o pagamento, independentemente se foi maior, menor ou exato, pois
        // o cliente pode estar dividindo a conta ou pagando partes separadas.
        const valorPago = parseFloat(pix.valor);

        // 3. Atualiza a tabela pagamento para PAGO, reajustando o valor para o que realmente foi pago
        const { error: errorPg } = await supabase
          .from("pagamento")
          .update({
            status: "pago",
            valor: valorPago, // Garante que reflete o que entrou de fato
            pago_em: new Date().toISOString(),
            metadados: {
              valor_recebido: valorPago,
              valor_esperado_original: pagamentoExistente.valor,
              endToEndId: pix.endToEndId,
              horarioPagamento: pix.horario,
              pagador: pix.pagador || null
            }
          })
          .eq("id", pagamentoExistente.id);

        if (!errorPg && pagamentoExistente.comanda_id) {
          // 4. Somar todos os pagamentos já concluídos dessa comanda
          const { data: pagamentosComanda } = await supabase
            .from("pagamento")
            .select("valor")
            .eq("comanda_id", pagamentoExistente.comanda_id)
            .eq("status", "pago");

          const totalPago = pagamentosComanda 
            ? pagamentosComanda.reduce((acc, p) => acc + parseFloat(p.valor), 0)
            : 0;

          // 5. Busca o valor total da comanda
          const { data: comanda } = await supabase
            .from("comanda")
            .select("valor_total, status")
            .eq("id", pagamentoExistente.comanda_id)
            .single();

          if (comanda && (comanda.status === "aguardando_pagamento" || comanda.status === "pagamento_iniciado")) {
            const valorTotalComanda = parseFloat(comanda.valor_total || "0");
            
            if (totalPago >= valorTotalComanda) {
              // Se a soma de todas as frações pagas atingir o total, libera a comanda!
              const { error: errorComanda } = await supabase
                .from("comanda")
                .update({ status: "aberta" })
                .eq("id", pagamentoExistente.comanda_id);
              
              resultados.push({ txid: pix.txid, comanda: pagamentoExistente.comanda_id, acao: "Comanda totalmente paga e ABERTA.", comanda_atualizada: !errorComanda });
            } else {
              // Atualiza o status para pagamento_iniciado caso falte dinheiro (pagamento parcial)
              const { error: errorComanda } = await supabase
                .from("comanda")
                .update({ status: "pagamento_iniciado" })
                .eq("id", pagamentoExistente.comanda_id);

               resultados.push({ txid: pix.txid, comanda: pagamentoExistente.comanda_id, acao: `Pagamento parcial aceito. Total pago: ${totalPago}/${valorTotalComanda}. Comanda atualizada para pagamento_iniciado.`, comanda_atualizada: !errorComanda });
            }
          } else {
            resultados.push({ txid: pix.txid, comanda: pagamentoExistente.comanda_id, acao: "Pagamento computado, mas comanda não estava aguardando pagamento ou sem valor total definido." });
          }
        } else {
          resultados.push({ txid: pix.txid, erro: "Erro ao atualizar status do pagamento para pago." });
        }
      }

      return new Response(JSON.stringify({ success: true, processed: resultados }), { status: 200, headers: corsHeaders });
    }

    // ==========================================
    // ROTA 3: CONFIGURAR WEBHOOK NO BANCO
    // ==========================================
    if (path.endsWith("/webhook/config") && req.method === "PUT") {
      const { webhookUrl } = await req.json(); // ex: https://seu-project.supabase.co/functions/v1/pagamentos/webhook
      if (!webhookUrl) return new Response("Informe { webhookUrl }", { status: 400 });

      const { accessToken, mtlsClient } = await getC6Token(config);
      const configUrl = `${getBaseUrl(config.env)}/v2/pix/webhook/${config.pixKey}`;

      const configReq = await fetch(configUrl, {
        method: "PUT",
        client: mtlsClient,
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ webhookUrl })
      });

      if (!configReq.ok) throw new Error(`Falha ao configurar webhook: ${await configReq.text()}`);

      return new Response(JSON.stringify({ success: true, message: "Webhook configurado no C6 Bank com sucesso." }), { status: 200, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: "Rota não encontrada. Tente /cob, /webhook ou /webhook/config" }), { status: 404, headers: corsHeaders });

  } catch (error: any) {
    console.error("Erro interno no Microserviço PIX:", error.message);
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders });
  }
});
