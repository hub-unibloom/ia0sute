export interface Env {
  // Bindings
  C6_MTLS: Fetcher; // O Cloudflare fará o bind do certificado MTLS aqui

  // Vars
  C6_ENV: "sandbox" | "production";
  C6_CLIENT_ID: string;
  C6_CLIENT_SECRET: string;
  C6_PIX_KEY: string;

  // Supabase (Opcional, para gravação do pagamento)
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Apenas POST é aceito
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), { 
        status: 405, 
        headers: { 'Content-Type': 'application/json' } 
      });
    }

    try {
      const body = await request.json<any>();
      const { valor, devedor, descricao, txid, contrato_id } = body;

      if (!valor || !devedor || !devedor.nome || !devedor.cpf_cnpj) {
        return new Response(JSON.stringify({ error: 'Faltam dados obrigatórios (valor, devedor.nome, devedor.cpf_cnpj)' }), { status: 400 });
      }

      const baseURL = env.C6_ENV === 'production' 
        ? 'https://baas-api.c6bank.info' 
        : 'https://baas-api-sandbox.c6bank.info';

      // ==========================================
      // Passo 1: Autenticação OAuth2 (MTLS required)
      // ==========================================
      const authHeader = btoa(`${env.C6_CLIENT_ID}:${env.C6_CLIENT_SECRET}`);
      
      const tokenRequest = new Request(`${baseURL}/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      });

      // Executa o request passando pelo MTLS Binding do Cloudflare
      const tokenResponse = await env.C6_MTLS.fetch(tokenRequest);
      
      if (!tokenResponse.ok) {
        const err = await tokenResponse.text();
        console.error('Erro na autenticação C6:', err);
        return new Response(JSON.stringify({ error: 'Falha na autenticação bancária', details: err }), { status: 502 });
      }

      const tokenData = await tokenResponse.json<{ access_token: string }>();
      const accessToken = tokenData.access_token;

      // ==========================================
      // Passo 2: Criação da Cobrança Imediata (COB)
      // ==========================================
      // Montagem minuciosa do payload conforme schema "CobSolicitada" do pix.json
      const cobPayload: any = {
        calendario: {
          expiracao: 86400 // 24 horas de validade para o PIX
        },
        valor: {
          original: parseFloat(valor).toFixed(2) // Formatado estritamente com 2 casas decimais
        },
        chave: env.C6_PIX_KEY,
        solicitacaoPagador: descricao || 'Pagamento referente ao contrato'
      };

      // Devedor condicional CPF vs CNPJ conforme regra BACEN
      const documentoSanitizado = devedor.cpf_cnpj.replace(/\D/g, '');
      if (documentoSanitizado.length === 11) {
        cobPayload.devedor = { nome: devedor.nome, cpf: documentoSanitizado };
      } else if (documentoSanitizado.length === 14) {
        cobPayload.devedor = { nome: devedor.nome, cnpj: documentoSanitizado };
      }

      const cobUrl = txid ? `${baseURL}/v2/pix/cob/${txid}` : `${baseURL}/v2/pix/cob`;
      const cobMethod = txid ? 'PUT' : 'POST';

      const cobRequest = new Request(cobUrl, {
        method: cobMethod,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(cobPayload)
      });

      // Emissão da Cobrança passando pelo túnel MTLS
      const cobResponse = await env.C6_MTLS.fetch(cobRequest);

      if (!cobResponse.ok) {
        const err = await cobResponse.text();
        console.error('Erro na criação da cobrança C6:', err);
        return new Response(JSON.stringify({ error: 'Falha ao criar cobrança', details: err }), { status: 502 });
      }

      const cobData = await cobResponse.json<any>();

      // ==========================================
      // Passo 3: Retorno do EMV (Copia e Cola)
      // ==========================================
      // A resposta do banco (/cob) traz a `location` (URL do payload). 
      // Mas para o QR Code, precisamos da string EMV (brcode).
      // Alguns bancos retornam a string pronta, outros precisam chamar o endpoint do BRCode ou montar.
      // Segundo o padrão Bacen, o BRCode pode vir em cobData.pixCopiaECola ou location precisa ser parseada.
      // Vamos retornar o objeto completo da Cobrança para o Frontend montar o QR Code via QRCode.js
      
      return new Response(JSON.stringify({
        success: true,
        cob: cobData,
        // O campo brcode ou pixCopiaECola costuma estar presente dependendo do parceiro. 
        // Caso não esteja, o Frontend usa o `location` gerado.
        location: cobData.location, 
        txid: cobData.txid,
        contrato_id: contrato_id
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error: any) {
      console.error('Exceção capturada:', error.message);
      return new Response(JSON.stringify({ error: 'Erro interno no Worker', message: error.message }), { status: 500 });
    }
  }
};
