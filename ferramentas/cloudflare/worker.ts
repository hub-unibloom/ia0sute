/**
 * Cloudflare Worker - Ponte de Memória Inteligente & Camada de Segurança (EverOS Cloud / Sensacional.site)
 * 
 * Funcionalidades principais:
 * 1. Integração com a engine de memória persistente da Evermind AI (EverOS Cloud v2 API).
 * 2. Rate Limiting rigoroso por chave de API e por tipo de operação (5, 15, 30 req/min).
 * 3. Suporte rico a contexto de localização geográfica (cidade, bairro, localidade_id, coordenadas).
 * 4. Respostas amigáveis em JSON e Texto para IAs parceiras e copilotos de frente quando houver HTTP 429.
 * 5. Telemetria de borda e auditoria assíncrona no Supabase (ia_copiloto e ia_copiloto_log).
 */

const SUPABASE_URL = 'https://tcxhuryqrzidvrltjhiz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xz1PSjOLImkMDkF3waRw1g_EAl1DiZ1';

// --- CONFIGURAÇÃO DE RATE LIMIT POR TIPO DE OPERAÇÃO (REQ / MIN) ---
const RATE_LIMIT_REGRAS: Record<string, number> = {
  'criar_necessidade': 5,
  'relatar_problema': 5,
  'cadastrar_item': 15,
  'cadastrar_habilidade': 15,
  'consultar_memoria': 15,
  'consultar_pagamento': 20,  // Consultas de status de pagamento e contrato
  'obter_perfil': 15,
  'buscar_recomendacao': 30,
  'recomendar_produtos': 30,
  'operacao_padrao': 20
};

// Armazenamento em memória local (fallback quando KV não estiver vinculado)
const rateLimitMap = new Map<string, number[]>();

async function checarRateLimit(apiKeyHash: string, operacao: string, env?: any): {
  permitido: boolean;
  limite: number;
  restantes: number;
  retryAfterSec: number;
} {
  const limite = RATE_LIMIT_REGRAS[operacao] || RATE_LIMIT_REGRAS['operacao_padrao'];
  const chaveKv = `rl:${apiKeyHash}:${operacao}`;
  const agoraMs = Date.now();
  const janelaInicioMs = agoraMs - 60_000;

  // 1. TENTATIVA DE USO DE CLOUDFLARE KV (SE CONFIGURADO NO AMBIENTE)
  if (env && env.RATE_LIMIT_KV) {
    try {
      const rawData = await env.RATE_LIMIT_KV.get(chaveKv, { type: 'json' });
      let timestamps: number[] = Array.isArray(rawData) ? rawData : [];
      timestamps = timestamps.filter(t => t > janelaInicioMs);

      if (timestamps.length >= limite) {
        const maisAntigo = timestamps[0] || agoraMs;
        const retryAfterSec = Math.ceil((maisAntigo + 60_000 - agoraMs) / 1000);
        return {
          permitido: false,
          limite,
          restantes: 0,
          retryAfterSec: Math.max(1, retryAfterSec)
        };
      }

      timestamps.push(agoraMs);
      // Salva no KV com expiração automática de 60 segundos (TTL)
      await env.RATE_LIMIT_KV.put(chaveKv, JSON.stringify(timestamps), { expirationTtl: 60 });

      return {
        permitido: true,
        limite,
        restantes: limite - timestamps.length,
        retryAfterSec: 0
      };
    } catch (err) {
      console.warn('[Worker RateLimit] Falha ao acessar KV, utilizando fallback de memória:', err);
    }
  }

  // 2. FALLBACK PARA MEMÓRIA RAM DO WORKER ISOLATE (ZERO LATÊNCIA EXTERNA)
  let timestamps = rateLimitMap.get(chaveKv) || [];
  timestamps = timestamps.filter(t => t > janelaInicioMs);

  if (timestamps.length >= limite) {
    const maisAntigo = timestamps[0];
    const retryAfterSec = Math.ceil((maisAntigo + 60_000 - agoraMs) / 1000);
    rateLimitMap.set(chaveKv, timestamps);
    return {
      permitido: false,
      limite,
      restantes: 0,
      retryAfterSec: Math.max(1, retryAfterSec)
    };
  }

  timestamps.push(agoraMs);
  rateLimitMap.set(chaveKv, timestamps);

  if (rateLimitMap.size > 10_000) {
    for (const [k, ts] of rateLimitMap.entries()) {
      if (ts.length === 0 || ts[ts.length - 1] < janelaInicioMs) {
        rateLimitMap.delete(k);
      }
    }
  }

  return {
    permitido: true,
    limite,
    restantes: limite - timestamps.length,
    retryAfterSec: 0
  };
}

function normalizarUrgencia(valor: string | undefined | null): string {
  if (!valor) return 'media';
  const v = valor.toLowerCase().trim();
  if (v === 'baixa') return 'baixa';
  if (v === 'media') return 'media';
  if (v === 'alta') return 'alta';
  if (v === 'emergencia' || v === 'urgente' || v === 'critica' || v === 'imediata' || v === 'sos') return 'emergencia';
  if (v === 'agendado' || v === 'agenda' || v === 'marcado' || v === 'futuro' || v === 'quando_puder' || v === 'sem_pressa') return 'baixa';
  if (v === 'importante' || v === 'prioritaria') return 'alta';
  return 'media';
}

function decodeBase64Utf8(base64Str: string): string {
  let base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

async function gerarHashApiKey(apiKey: string): Promise<string> {
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Integre com EverOS Cloud API v2 (POST /api/v2/memory/add)
async function adicionarMemoriaEverOS(env: any, payload: {
  sessionId: string;
  senderId: string;
  conteudo: string;
  cidade?: string | null;
  bairro?: string | null;
  metadataExtra?: any;
}) {
  const baseUrl = env.EVEROS_BASE_URL || 'https://api.evermind.ai';
  const apiKey = env.EVEROS_API_KEY;

  if (!apiKey) {
    console.warn('[Worker EverOS] EVEROS_API_KEY não configurada. Ingestão em memória ignorada.');
    return null;
  }

  const localizacaoTxt = [payload.bairro ? `Bairro: ${payload.bairro}` : null, payload.cidade ? `Cidade: ${payload.cidade}` : null].filter(Boolean).join(', ');
  const mensagemFormatada = localizacaoTxt ? `[Localização Geográfica: ${localizacaoTxt}] ${payload.conteudo}` : payload.conteudo;

  try {
    const res = await fetch(`${baseUrl}/api/v2/memory/add`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session_id: payload.sessionId,
        async_mode: true,
        messages: [
          {
            sender_id: payload.senderId,
            role: 'user',
            timestamp: Date.now(),
            content: mensagemFormatada
          }
        ]
      })
    });
    return await res.json();
  } catch (e) {
    console.error('[Worker EverOS] Erro ao adicionar memória:', e);
    return null;
  }
}

// Integre com EverOS Cloud API v2 (POST /api/v2/memory/search)
async function buscarMemoriaEverOS(env: any, query: string, userIdOrAgentId: string, cidade?: string | null, bairro?: string | null) {
  const baseUrl = env.EVEROS_BASE_URL || 'https://api.evermind.ai';
  const apiKey = env.EVEROS_API_KEY;

  if (!apiKey) {
    console.warn('[Worker EverOS] EVEROS_API_KEY não configurada. Busca em memória ignorada.');
    return null;
  }

  const localizacaoFiltro = [bairro, cidade].filter(Boolean).join(' ');
  const queryFinal = localizacaoFiltro ? `${query} em ${localizacaoFiltro}` : query;

  try {
    const res = await fetch(`${baseUrl}/api/v2/memory/search`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: queryFinal,
        user_id: userIdOrAgentId,
        method: 'hybrid',
        top_k: 5
      })
    });
    return await res.json();
  } catch (e) {
    console.error('[Worker EverOS] Erro ao buscar memória:', e);
    return null;
  }
}

// Resposta amigável para HTTP 429
function criarRespostaRateLimit(operacao: string, stats: { limite: number; retryAfterSec: number }): Response {
  const jsonBody = {
    sucesso: false,
    erro: 'rate_limit_excedido',
    status_code: 429,
    operacao,
    limite_por_minuto: stats.limite,
    retry_after_segundos: stats.retryAfterSec,
    mensagem: `O limite de requisições para a operação '${operacao}' (${stats.limite} chamadas/min) foi atingido.`,
    mensagem_ia_amigavel: `Atenção: A frequência de solicitações de memória para a operação '${operacao}' excedeu o limite de segurança (${stats.limite} req/minuto). Aguarde aproximadamente ${stats.retryAfterSec} segundo(s) antes de tentar novamente. A Sensacional preserva a segurança e a integridade da IA.`
  };

  return new Response(JSON.stringify(jsonBody, null, 2), {
    status: 429,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': String(stats.retryAfterSec),
      'X-RateLimit-Limit': String(stats.limite),
      'X-RateLimit-Remaining': '0',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const inicioMs = Date.now();
    const url = new URL(request.url);
    const pathname = url.pathname.toLowerCase();
    const metodo = request.method.toUpperCase();

    // === EXTRAÇÃO DE TELEMETRIA RICA DE BORDA ===
    const cf: any = (request as any).cf || {};
    const userAgent = request.headers.get('user-agent') || 'desconhecido';
    const clientIp = request.headers.get('cf-connecting-ip') || 'desconhecido';

    const telemetriaBorda = {
      provedor_ia: cf.asOrganization || 'desconhecido',
      asn_provedor: cf.asn || null,
      pais_servidor: cf.country || 'desconhecido',
      cidade_servidor: cf.city || 'desconhecido',
      estado_servidor: cf.region || cf.regionCode || null,
      datacenter_cloudflare: cf.colo || 'desconhecido',
      fuso_horario: cf.timezone || null,
      user_agent: userAgent,
      ip_origem: clientIp,
      protocolo_http: cf.httpProtocol || null,
      latencia_tcp_rtt_ms: cf.clientTcpRtt || null,
      versao_tls: cf.tlsVersion || null,
      timestamp_borda: new Date().toISOString()
    };

    // Extrair chave de API da requisição
    let apiKeyEnviada = request.headers.get('x-ia-api-key') || url.searchParams.get('api_key') || null;
    let isNovaChave = false;

    if (!apiKeyEnviada) {
      const randomBytes = crypto.getRandomValues(new Uint8Array(16));
      const hexString = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
      apiKeyEnviada = `sk_ia_${hexString}`;
      isNovaChave = true;
    }

    const apiKeyHash = await gerarHashApiKey(apiKeyEnviada);
    const prefix = apiKeyEnviada.substring(0, 8);

    // --- ROTEAMENTO E PROCESSAMENTO POR ENDPOINT ---

    // CORS Preflight
    if (metodo === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-ia-api-key',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // 1. ENDPOINT: /api/v1/necessidade (CRIAR NECESSIDADE / RELATAR PROBLEMA)
    if ((pathname === '/api/v1/necessidade' || pathname === '/api/v1/necessidades') && metodo === 'POST') {
      const operacao = 'criar_necessidade';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);

      if (!rlStats.permitido) {
        return criarRespostaRateLimit(operacao, rlStats);
      }

      let body: any = {};
      try {
        body = await request.json();
      } catch (_e) {
        body = {};
      }

      const idNecessidade = body.id || crypto.randomUUID();
      const descNecessidade = body.descricao_necessidade || body.descricao || body.problema || 'Necessidade não especificada';
      const cidade = body.cidade || null;
      const bairro = body.bairro || null;
      const localidadeId = body.localidade_id || null;
      const urgencia = normalizarUrgencia(body.urgencia);

      // Ingestão no Supabase (non-blocking)
      ctx.waitUntil(
        fetch(`${SUPABASE_URL}/rest/v1/necessidade`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates,return=minimal'
          },
          body: JSON.stringify({
            id: idNecessidade,
            descricao_necessidade: descNecessidade,
            urgencia,
            cidade,
            bairro,
            localidade_id: localidadeId,
            status: 'pendente',
            mensagem_origem: JSON.stringify(body)
          })
        }).catch(err => console.error('[Worker] Erro ao salvar necessidade Supabase:', err))
      );

      // Ingestão no EverOS Cloud (non-blocking)
      ctx.waitUntil(
        adicionarMemoriaEverOS(env, {
          sessionId: `sess_${idNecessidade}`,
          senderId: apiKeyHash,
          conteudo: `Necessidade registrada: ${descNecessidade}. Urgência: ${urgencia}.`,
          cidade,
          bairro
        })
      );

      const duracaoMs = Date.now() - inicioMs;
      // Auditoria no Supabase
      ctx.waitUntil(
        fetch(`${SUPABASE_URL}/rest/v1/ia_copiloto_log`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ia_copiloto_id: idNecessidade, endpoint: pathname, metodo, status_code: 201, duracao_ms: duracaoMs, ip_origem: clientIp, user_agent: userAgent, necessidade_id: idNecessidade, metadata: { telemetria: telemetriaBorda, operacao } })
        }).catch(err => console.error('[Worker] Erro log:', err))
      );

      return new Response(JSON.stringify({
        sucesso: true,
        id_necessidade: idNecessidade,
        cidade,
        bairro,
        status: 'pendente',
        mensagem: 'Necessidade e relato do problema registrados com sucesso na Sensacional e sincronizados com EverOS Memory.'
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 2. ENDPOINT: /api/v1/item (CADASTRAR PRODUTO / SERVIÇO / HABILIDADE)
    if ((pathname === '/api/v1/item' || pathname === '/api/v1/itens') && metodo === 'POST') {
      const operacao = 'cadastrar_item';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);

      if (!rlStats.permitido) {
        return criarRespostaRateLimit(operacao, rlStats);
      }

      let body: any = {};
      try { body = await request.json(); } catch (_e) { body = {}; }

      const idItem = body.id || crypto.randomUUID();
      const nome = body.nome || 'Item Sem Nome';
      const desc = body.descricao || '';
      const tipoOferta = body.tipo_oferta || 'servico'; // 'produto' | 'servico' | 'habilidade'
      const cidade = body.cidade || null;
      const bairro = body.bairro || null;
      const precoMin = body.preco_min || body.preco || null;

      // Ingestão no Supabase
      ctx.waitUntil(
        fetch(`${SUPABASE_URL}/rest/v1/item`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({
            id: idItem,
            nome,
            slug: `${nome.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${idItem.substring(0, 8)}`,
            descricao: desc,
            tipo_oferta: tipoOferta,
            preco_min: precoMin,
            disponivel: true,
            status: 'publicado'
          })
        }).catch(err => console.error('[Worker] Erro ao cadastrar item:', err))
      );

      // Ingestão de conhecimento no EverOS
      ctx.waitUntil(
        adicionarMemoriaEverOS(env, {
          sessionId: `item_${idItem}`,
          senderId: 'sistema_item',
          conteudo: `Oferta/Item cadastrado (${tipoOferta}): ${nome}. Descrição: ${desc}. Preço estimado: R$ ${precoMin || 'sob consulta'}.`,
          cidade,
          bairro
        })
      );

      return new Response(JSON.stringify({
        sucesso: true,
        id_item: idItem,
        nome,
        cidade,
        bairro,
        mensagem: 'Oferta/Habilidade registrada com sucesso no catálogo e indexada no EverOS Cloud.'
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 3. ENDPOINT: /api/v1/recomendar (BUSCAR RECOMENDAÇÕES DE SERVIÇOS / PRODUTOS COM EVEROS MEMORY)
    if ((pathname === '/api/v1/recomendar' || pathname === '/api/v1/recomendacao') && (metodo === 'GET' || metodo === 'POST')) {
      const operacao = 'buscar_recomendacao';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);

      if (!rlStats.permitido) {
        return criarRespostaRateLimit(operacao, rlStats);
      }

      let busca = '';
      let cidade: string | null = null;
      let bairro: string | null = null;

      if (metodo === 'GET') {
        busca = url.searchParams.get('q') || url.searchParams.get('busca') || '';
        cidade = url.searchParams.get('cidade');
        bairro = url.searchParams.get('bairro');
      } else {
        let body: any = {};
        try { body = await request.json(); } catch (_e) { body = {}; }
        busca = body.q || body.busca || body.necessidade || '';
        cidade = body.cidade || null;
        bairro = body.bairro || null;
      }

      // Consulta de memória com EverOS
      const memoriaEverOS = await buscarMemoriaEverOS(env, busca, apiKeyHash, cidade, bairro);

      // Consulta complementar no Supabase
      let itensRelacionais: any[] = [];
      try {
        const querySupabase = `${SUPABASE_URL}/rest/v1/item?select=id,nome,descricao,tipo_oferta,preco_min,loja(nome),profissional_id&status=eq.publicado&limit=5`;
        const respSupabase = await fetch(querySupabase, {
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` }
        });
        if (respSupabase.ok) {
          itensRelacionais = await respSupabase.json();
        }
      } catch (err) {
        console.error('[Worker] Erro ao buscar itens Supabase:', err);
      }

      return new Response(JSON.stringify({
        sucesso: true,
        busca,
        localizacao: { cidade, bairro },
        recomendacoes_memoria_everos: memoriaEverOS?.data?.episodes || memoriaEverOS || [],
        itens_catalogo_sensacional: itensRelacionais,
        mensagem: 'Recomendações recuperadas com sucesso combinando EverOS Memory e catálogo Sensacional.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 4. ENDPOINT: /api/v1/pagamento/status (CONSULTAR STATUS DE PAGAMENTO)
    // Aceita GET com ?txid=... ou ?pagamento_id=... para IAs externas
    // Aceita POST com corpo JSON ou base64 via ?corpo-url=...
    if (pathname === '/api/v1/pagamento/status') {
      const operacao = 'consultar_pagamento';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);
      if (!rlStats.permitido) return criarRespostaRateLimit(operacao, rlStats);

      let txid: string | null = null;
      let pagamentoId: string | null = null;
      let comandaId: string | null = null;

      if (metodo === 'GET') {
        txid = url.searchParams.get('txid');
        pagamentoId = url.searchParams.get('pagamento_id');
        comandaId = url.searchParams.get('comanda_id');
        // Suporte ao padrão base64 do worker para IAs que passam ?corpo-url=
        const corpoB64 = url.searchParams.get('corpo-url');
        if (corpoB64) {
          try {
            const decoded = JSON.parse(decodeBase64Utf8(corpoB64));
            txid = decoded.txid || txid;
            pagamentoId = decoded.pagamento_id || pagamentoId;
            comandaId = decoded.comanda_id || comandaId;
          } catch (_) {}
        }
      } else if (metodo === 'POST') {
        try {
          const body: any = await request.json();
          txid = body.txid || null;
          pagamentoId = body.pagamento_id || null;
          comandaId = body.comanda_id || null;
        } catch (_) {}
      }

      if (!txid && !pagamentoId && !comandaId) {
        return new Response(JSON.stringify({ sucesso: false, erro: 'Informe txid, pagamento_id ou comanda_id.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      let queryUrl = `${SUPABASE_URL}/rest/v1/pagamento?select=id,status,valor,pago_em,gateway,gateway_pagamento_id,metadados,comanda_id,metodo,moeda&limit=10`;
      if (txid) queryUrl += `&gateway_pagamento_id=eq.${encodeURIComponent(txid)}`;
      if (pagamentoId) queryUrl += `&id=eq.${encodeURIComponent(pagamentoId)}`;
      if (comandaId) queryUrl += `&comanda_id=eq.${encodeURIComponent(comandaId)}`;

      let pagamentos: any[] = [];
      try {
        const resp = await fetch(queryUrl, { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } });
        if (resp.ok) pagamentos = await resp.json();
      } catch (err) { console.error('[Worker] Erro ao consultar pagamento:', err); }

      const totalPago = pagamentos.filter(p => p.status === 'pago').reduce((acc, p) => acc + parseFloat(p.valor), 0);

      return new Response(JSON.stringify({
        sucesso: true,
        pagamentos,
        total_pago: totalPago.toFixed(2),
        mensagem_ia: pagamentos.length === 0
          ? 'Nenhum pagamento encontrado com os critérios informados.'
          : `Encontrado(s) ${pagamentos.length} pagamento(s). Total pago: R$ ${totalPago.toFixed(2)}.`
      }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }

    // 5. ENDPOINT: /api/v1/pagamento/pix-key (CONSULTAR CHAVE PIX DO RECEBEDOR)
    // Rota simples de leitura para IAs obterem a chave PIX e gerarem ou verificarem cobranças
    if (pathname === '/api/v1/pagamento/pix-key' && metodo === 'GET') {
      const operacao = 'consultar_pagamento';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);
      if (!rlStats.permitido) return criarRespostaRateLimit(operacao, rlStats);

      // A chave PIX fica em env.C6_PIX_KEY mas neste worker não temos acesso.
      // Busca do Supabase se houver uma tabela de config, senão retorna o dado fixo.
      const pixKey = env.C6_PIX_KEY || null;

      return new Response(JSON.stringify({
        sucesso: true,
        chave_pix: pixKey,
        gateway: 'c6bank',
        moeda: 'BRL',
        mensagem_ia: pixKey
          ? `A chave PIX de recebimento é: ${pixKey}. Use para solicitar pagamentos.`
          : 'Chave PIX não configurada neste ambiente. Contate o administrador.'
      }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }

    // 6. ENDPOINT: /api/v1/contrato/link (GERAR/CONSULTAR LINK DE CONTRATO)
    // Aceita GET com ?contrato_id=... para IAs consultarem o link de download do contrato
    if (pathname === '/api/v1/contrato/link' && (metodo === 'GET' || metodo === 'POST')) {
      const operacao = 'consultar_memoria';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);
      if (!rlStats.permitido) return criarRespostaRateLimit(operacao, rlStats);

      let contratoId: string | null = null;
      let txid: string | null = null;

      if (metodo === 'GET') {
        contratoId = url.searchParams.get('contrato_id');
        txid = url.searchParams.get('txid');
        const corpoB64 = url.searchParams.get('corpo-url');
        if (corpoB64) {
          try {
            const decoded = JSON.parse(decodeBase64Utf8(corpoB64));
            contratoId = decoded.contrato_id || contratoId;
            txid = decoded.txid || txid;
          } catch (_) {}
        }
      } else {
        try {
          const body: any = await request.json();
          contratoId = body.contrato_id || null;
          txid = body.txid || null;
        } catch (_) {}
      }

      if (!contratoId && !txid) {
        return new Response(JSON.stringify({ sucesso: false, erro: 'Informe contrato_id ou txid.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      // Consulta o pagamento via txid para obter comanda/contrato vinculado
      let contratoInfo: any = null;
      try {
        let queryUrl = `${SUPABASE_URL}/rest/v1/pagamento?select=id,status,metadados,comanda_id&limit=1`;
        if (txid) queryUrl += `&gateway_pagamento_id=eq.${encodeURIComponent(txid)}`;
        if (contratoId) queryUrl += `&metadados->>contrato_id=eq.${encodeURIComponent(contratoId)}`;

        const resp = await fetch(queryUrl, { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } });
        if (resp.ok) {
          const rows: any[] = await resp.json();
          contratoInfo = rows[0] || null;
        }
      } catch (err) { console.error('[Worker] Erro ao consultar contrato:', err); }

      const linkContrato = contratoInfo?.metadados?.location || contratoInfo?.metadados?.link_contrato || null;
      const statusPagamento = contratoInfo?.status || 'desconhecido';

      return new Response(JSON.stringify({
        sucesso: true,
        contrato_id: contratoId || contratoInfo?.metadados?.contrato_id,
        txid: txid,
        status_pagamento: statusPagamento,
        link_contrato: linkContrato,
        mensagem_ia: linkContrato
          ? `O link do contrato está disponível: ${linkContrato}. Status do pagamento associado: ${statusPagamento}.`
          : 'Contrato não localizado ou link ainda não disponível. Verifique o contrato_id ou txid informado.'
      }), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }

    // 7. ENDPOINT: /api/v1/pagamento/solicitar-pix (SOLICITAR NOVO PIX VIA SUPABASE EDGE FUNCTION)
    // Para IAs que precisam disparar uma cobrança nova em nome de uma comanda
    // Aceita GET com corpo-url=base64 para manter compatibilidade com IAs sem POST
    if (pathname === '/api/v1/pagamento/solicitar-pix') {
      const operacao = 'criar_necessidade'; // deliberadamente mais restrito
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);
      if (!rlStats.permitido) return criarRespostaRateLimit(operacao, rlStats);

      let payload: any = {};

      if (metodo === 'GET') {
        const corpoB64 = url.searchParams.get('corpo-url');
        if (!corpoB64) {
          return new Response(JSON.stringify({ sucesso: false, erro: 'Para GET, informe o parâmetro corpo-url com o payload em base64 (JSON: valor, devedor, comanda_id).' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
        try {
          payload = JSON.parse(decodeBase64Utf8(corpoB64));
        } catch (_) {
          return new Response(JSON.stringify({ sucesso: false, erro: 'Falha ao decodificar corpo-url. Certifique-se que é base64 válido de um JSON.' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
        }
      } else if (metodo === 'POST') {
        try { payload = await request.json(); } catch (_) {}
      }

      // Encaminha para a Supabase Edge Function de pagamentos
      const supabaseEdgeUrl = `${SUPABASE_URL}/functions/v1/pagamentos/cob`;
      let pixResposta: any = null;
      try {
        const resp = await fetch(supabaseEdgeUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          },
          body: JSON.stringify(payload)
        });
        pixResposta = await resp.json();
      } catch (err) {
        console.error('[Worker] Erro ao solicitar PIX via Edge Function:', err);
        return new Response(JSON.stringify({ sucesso: false, erro: 'Falha ao comunicar com o microserviço de pagamentos.' }), { status: 502, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
      }

      return new Response(JSON.stringify({
        sucesso: pixResposta?.success || false,
        ...pixResposta,
        mensagem_ia: pixResposta?.success
          ? `PIX gerado com sucesso! txid: ${pixResposta.txid}. Copie e Cole: ${pixResposta.pix_emv || pixResposta.location}`
          : `Falha ao gerar PIX: ${pixResposta?.error || 'Erro desconhecido.'}`
      }), { status: pixResposta?.success ? 201 : 502, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
    }

    // 8. SUPORTE A LEGADO / CORPO-URL (QUERY PARAMETER DE TELEMETRIA)
    const corpoUrlRaw = url.searchParams.get('corpo-url');
    if (corpoUrlRaw) {
      const operacao = 'criar_necessidade';
      const rlStats = await checarRateLimit(apiKeyHash, operacao, env);

      if (!rlStats.permitido) {
        return criarRespostaRateLimit(operacao, rlStats);
      }

      let payloadObj: any = null;
      let formatoPayload = 'texto_puro';

      try {
        const decodedText = decodeBase64Utf8(corpoUrlRaw);
        payloadObj = JSON.parse(decodedText);
        formatoPayload = 'base64_json';
      } catch (_e) {
        try {
          payloadObj = JSON.parse(corpoUrlRaw);
          formatoPayload = 'json_direto';
        } catch (_e2) {
          payloadObj = { descricao_necessidade: corpoUrlRaw };
          formatoPayload = 'texto_puro';
        }
      }

      const descNecessidade = payloadObj?.descricao_necessidade || payloadObj?.descricao || payloadObj?.raw_texto || null;
      const nomeCopiloto = payloadObj?.nome || payloadObj?.canal_origem || descNecessidade || 'Copiloto I.A. Desconhecido';
      let idNecessidade = payloadObj?.id_necessidade || payloadObj?.id || crypto.randomUUID();
      const cidade = payloadObj?.cidade || null;
      const bairro = payloadObj?.bairro || null;

      const metadataCompleto = {
        telemetria_rede: telemetriaBorda,
        comportamento: {
          formato_envio: formatoPayload,
          tamanho_bytes: corpoUrlRaw.length,
          is_primeira_chamada: isNovaChave
        },
        payload_origem: payloadObj,
        url_requisicao: request.url
      };

      // Registrar Copiloto e Necessidade no Supabase
      ctx.waitUntil(
        fetch(`${SUPABASE_URL}/rest/v1/ia_copiloto`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ nome: nomeCopiloto, api_key_hash: apiKeyHash, api_key_prefix: prefix, ativo: true, metadata: metadataCompleto })
        }).catch(err => console.error('[Worker] Erro ia_copiloto:', err))
      );

      if (descNecessidade) {
        ctx.waitUntil(
          fetch(`${SUPABASE_URL}/rest/v1/necessidade`, {
            method: 'POST',
            headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              id: idNecessidade,
              descricao_necessidade: descNecessidade,
              urgencia: normalizarUrgencia(payloadObj?.urgencia),
              cidade,
              bairro,
              status: 'pendente',
              mensagem_origem: JSON.stringify(payloadObj)
            })
          }).catch(err => console.error('[Worker] Erro necessidade:', err))
        );

        // Ingestão assíncrona EverOS
        ctx.waitUntil(
          adicionarMemoriaEverOS(env, {
            sessionId: `sess_${idNecessidade}`,
            senderId: apiKeyHash,
            conteudo: `Necessidade via URL: ${descNecessidade}`,
            cidade,
            bairro
          })
        );
      }

      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('x-ia-api-key', apiKeyEnviada);
      modifiedHeaders.set('x-ia-is-nova-chave', isNovaChave ? '1' : '0');
      modifiedHeaders.set('x-ia-copiloto-nome', encodeURIComponent(nomeCopiloto));
      modifiedHeaders.set('x-ia-provedor', encodeURIComponent(telemetriaBorda.provedor_ia));
      modifiedHeaders.set('x-ia-pais', telemetriaBorda.pais_servidor);
      modifiedHeaders.set('x-ia-datacenter', telemetriaBorda.datacenter_cloudflare);
      if (idNecessidade) modifiedHeaders.set('x-ia-id-necessidade', idNecessidade);

      return fetch(new Request(request, { headers: modifiedHeaders }));
    }

    // Pass-through padrão para Astro SSR
    return fetch(request);
  }
};
