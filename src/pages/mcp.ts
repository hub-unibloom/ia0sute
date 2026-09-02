/**
 * Endpoint MCP (Model Context Protocol) — Transporte Streamable HTTP.
 * Roda na borda (Cloudflare SSR) e expõe as ferramentas do site da I.A.
 * SEM EXIGÊNCIA DE CREDENCIAIS DE LOGIN: o copiloto é registrado
 * anonimamente a partir do clientInfo da sessão MCP.
 */

export const prerender = false;

import { salvarOuAtualizarNecessidade, listarPessoas, registrarCopilotoSupabase, SUPABASE_URL, SUPABASE_ANON_KEY, type PessoaEncontrada } from '../lib/supabase';

const VERSAO_PROTOCOLO = '2025-06-18';
const PROTOCOLOS_SUPORTADOS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const HEADERS_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization, x-ia-api-key',
  'Access-Control-Expose-Headers': 'mcp-session-id',
};

function respostaRpc(id: any, result: any): any {
  return { jsonrpc: '2.0', id, result };
}

function erroRpc(id: any, code: number, message: string): any {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ============================================================
// Definição das ferramentas
// ============================================================

const FERRAMENTAS = [
  {
    name: 'abrir_necessidade',
    description: 'Registra uma NECESSIDADE real do usuário na plataforma Sensacional (serviços domésticos, reparos, instalações, manutenção). Use SEMPRE que o usuário relatar um problema ou desejar contratar alguém. A escolha do prestador é sempre do usuário — não invente dados, não prometa orçamento antes da resposta da API. Retorna o id da necessidade, a URL de acompanhamento e o status. Para ATUALIZAR uma necessidade existente, reenvie com id_necessidade.',
    inputSchema: {
      type: 'object',
      properties: {
        descricao_necessidade: { type: 'string', description: 'Descrição clara do problema ou serviço desejado, com as palavras do usuário.' },
        urgencia: { type: 'string', enum: ['baixa', 'media', 'alta', 'emergencia'], description: 'Urgência informada pelo usuário. Padrão: media.' },
        cidade: { type: 'string', description: 'Cidade onde o serviço será realizado.' },
        bairro: { type: 'string', description: 'Bairro onde o serviço será realizado.' },
        prazo_inicio: { type: 'string', description: 'Data/hora desejada de início (ISO 8601).' },
        prazo_conclusao: { type: 'string', description: 'Data/hora desejada de conclusão (ISO 8601).' },
        id_necessidade: { type: 'string', description: 'Preencha APENAS para atualizar uma necessidade já aberta.' },
        nome_copiloto: { type: 'string', description: 'Nome da I.A. copiloto. Padrão: nome informado na conexão MCP.' }
      },
      required: ['descricao_necessidade']
    }
  },
  {
    name: 'buscar_profissionais',
    description: 'Busca profissionais (pessoas) cadastradas na plataforma Sensacional. Use para mostrar opções reais ao usuário antes ou depois de abrir uma necessidade. Todos os filtros são opcionais e combináveis.',
    inputSchema: {
      type: 'object',
      properties: {
        busca: { type: 'string', description: 'Texto livre: profissão, serviço ou habilidade (ex: "eletricista", "encanador urgente").' },
        cidade: { type: 'string', description: 'Filtra por cidade.' },
        profissoes: { type: 'array', items: { type: 'string' }, description: 'Lista de profissões (E lógico com os demais filtros).' },
        habilidades: { type: 'array', items: { type: 'string' }, description: 'Lista de habilidades específicas.' },
        preco_min: { type: 'number', description: 'Preço mínimo de serviço.' },
        preco_max: { type: 'number', description: 'Preço máximo de serviço.' },
        atende_emergencia: { type: 'boolean', description: 'true para apenas quem atende emergências.' },
        limite: { type: 'number', description: 'Quantos resultados retornar (1 a 20). Padrão: 10.' },
        offset: { type: 'number', description: 'Paginação.' }
      }
    }
  },
  {
    name: 'ver_necessidade',
    description: 'Consulta o status atual de uma necessidade já aberta (pendente, em análise, concluída etc.). Use para acompanhar o andamento depois de abrir a necessidade.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID (UUID) da necessidade retornado por abrir_necessidade.' }
      },
      required: ['id']
    }
  }
];

// ============================================================
// Execução das ferramentas
// ============================================================

function normalizarUrgencia(valor: unknown): string {
  if (!valor) return 'media';
  const v = String(valor).toLowerCase().trim();
  if (['baixa', 'media', 'alta', 'emergencia'].includes(v)) return v;
  if (['urgente', 'critica', 'imediata', 'sos'].includes(v)) return 'emergencia';
  if (['agendado', 'agenda', 'marcado', 'futuro'].includes(v)) return 'baixa';
  if (['importante', 'prioritaria'].includes(v)) return 'alta';
  if (['quando_puder', 'sem_pressa'].includes(v)) return 'baixa';
  return 'media';
}

function textoResultado(texto: string, erro = false): any {
  return { content: [{ type: 'text', text: texto }], isError: erro };
}

async function executarFerramenta(nome: string, args: any, nomeCopilotoSessao: string): Promise<any> {
  args = args || {};

  if (nome === 'abrir_necessidade') {
    const descricao = String(args.descricao_necessidade || '').trim();
    if (!descricao) {
      return textoResultado('Erro: descricao_necessidade é obrigatória. Descreva o problema com as palavras do usuário.', true);
    }
    const nomeCopiloto = String(args.nome_copiloto || nomeCopilotoSessao || 'I.A. via MCP');
    const resultado = await salvarOuAtualizarNecessidade({
      idNecessidade: args.id_necessidade || null,
      descricao,
      urgencia: normalizarUrgencia(args.urgencia),
      cidade: args.cidade ? String(args.cidade) : undefined,
      bairro: args.bairro ? String(args.bairro) : undefined,
      canalOrigem: 'mcp',
      prazoInicio: args.prazo_inicio ? String(args.prazo_inicio) : null,
      prazoConclusao: args.prazo_conclusao ? String(args.prazo_conclusao) : null,
      payloadCompleto: args
    });

    if (!resultado.dbSuccess) {
      return textoResultado(`A necessidade não pôde ser salva no banco agora (${resultado.dbErrorDetails || 'erro desconhecido'}). Não invente confirmação: informe o usuário que houve falha temporária e tente novamente.`, true);
    }

    const acao = resultado.isNew ? 'criada' : 'atualizada';
    return textoResultado(JSON.stringify({
      sucesso: true,
      acao,
      id_necessidade: resultado.id,
      status: resultado.status,
      url_acompanhamento: `https://ai.sensacional.site/nescessidade/${resultado.id}`,
      orientacao: 'Informe ao usuário que a necessidade foi ' + acao + '. Aguarde soluções dos profissionais. NÃO prometa orçamento nem prazo: a escolha é sempre do usuário. Consulte o andamento com ver_necessidade.'
    }, null, 2));
  }

  if (nome === 'buscar_profissionais') {
    const resultado = await listarPessoas({
      busca: args.busca ? String(args.busca) : undefined,
      profissoes: Array.isArray(args.profissoes) ? args.profissoes.map(String) : undefined,
      habilidades: Array.isArray(args.habilidades) ? args.habilidades.map(String) : undefined,
      cidade: args.cidade ? String(args.cidade) : undefined,
      precoMin: typeof args.preco_min === 'number' ? args.preco_min : undefined,
      precoMax: typeof args.preco_max === 'number' ? args.preco_max : undefined,
      atendeEmergencia: typeof args.atende_emergencia === 'boolean' ? args.atende_emergencia : undefined,
      limite: Math.min(Math.max(Number(args.limite) || 10, 1), 20),
      offset: Number(args.offset) || 0
    });

    if (!resultado.sucesso) {
      return textoResultado(`A busca falhou agora (${resultado.erro || 'erro desconhecido'}). Informe o usuário da falha temporária e tente novamente.`, true);
    }

    const pessoas = resultado.pessoas.map((p: PessoaEncontrada) => ({
      codigo_publico: p.codigo_publico,
      nome: p.nome_publico,
      titulo: p.titulo,
      bio: p.bio,
      profissoes: p.profissoes,
      cidade: p.cidade,
      estado: p.estado,
      atende_emergencia: p.atende_emergencia,
      indice_confianca: p.indice_confianca,
      jobs_concluidos: p.jobs_concluidos,
      url_perfil: `https://ai.sensacional.site/p/${p.codigo_publico}`
    }));

    return textoResultado(JSON.stringify({
      sucesso: true,
      total: pessoas.length,
      orientacao: 'Apresente as opções reais encontradas. NÃO invente dados que não estejam aqui. A escolha do prestador é sempre do usuário. Se nenhuma opção servir, ofereça abrir uma necessidade com abrir_necessidade.',
      pessoas
    }, null, 2));
  }

  if (nome === 'ver_necessidade') {
    const id = String(args.id || '').trim();
    if (!id) {
      return textoResultado('Erro: id da necessidade é obrigatório.', true);
    }
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/necessidade?id=eq.${encodeURIComponent(id)}&select=*`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    if (!resp.ok) {
      return textoResultado(`A consulta falhou agora (HTTP ${resp.status}). Informe o usuário da falha temporária.`, true);
    }
    const rows = await resp.json();
    if (!rows || rows.length === 0) {
      return textoResultado(JSON.stringify({ sucesso: false, motivo: 'necessidade_nao_encontrada', id }), true);
    }
    const n = rows[0];
    return textoResultado(JSON.stringify({
      sucesso: true,
      id: n.id,
      status: n.status,
      urgencia: n.urgencia,
      descricao_necessidade: n.descricao_necessidade,
      cidade: n.cidade,
      bairro: n.bairro,
      criada_em: n.criado_em,
      atualizada_em: n.atualizado_em,
      url_acompanhamento: `https://ai.sensacional.site/nescessidade/${n.id}`
    }, null, 2));
  }

  return textoResultado(`Ferramenta desconhecida: ${nome}`, true);
}

// ============================================================
// Manipulação do protocolo MCP (JSON-RPC 2.0 / Streamable HTTP)
// ============================================================

type Processamento = { resposta?: any, headers?: Record<string, string>, notificacao?: boolean, registrarCopiloto?: string };

async function processarMensagem(mensagem: any, req: Request): Promise<Processamento> {
  const { id, method, params } = mensagem || {};

  if (method === 'initialize') {
    const versaoCliente = params?.protocolVersion;
    const versao = PROTOCOLOS_SUPORTADOS.includes(versaoCliente) ? versaoCliente : VERSAO_PROTOCOLO;
    return {
      resposta: respostaRpc(id, {
        protocolVersion: versao,
        capabilities: { tools: {} },
        serverInfo: { name: 'sensacional', title: 'Sensacional — Conexão I.A. a serviços reais', version: '1.0.0' },
        instructions: 'Você conecta usuários reais a serviços de profissionais. Use abrir_necessidade quando o usuário relatar um problema ou quiser contratar alguém; use buscar_profissionais para mostrar opções reais; use ver_necessidade para acompanhar. Vá um passo de cada vez. Não invente dados. A escolha é sempre do usuário.'
      }),
      headers: { 'Mcp-Session-Id': crypto.randomUUID() }
    };
  }

  if (method === 'tools/list') {
    return { resposta: respostaRpc(id, { tools: FERRAMENTAS }) };
  }

  if (method === 'tools/call') {
    const nomeFerramenta = params?.name;
    const existe = FERRAMENTAS.some(f => f.name === nomeFerramenta);
    if (!existe) {
      return { resposta: erroRpc(id, -32602, `Ferramenta desconhecida: ${nomeFerramenta}`) };
    }
    try {
      const nomeSessao = req.headers.get('x-ia-copiloto-nome');
      const resultado = await executarFerramenta(nomeFerramenta, params?.arguments, nomeSessao ? decodeURIComponent(nomeSessao) : '');
      return { resposta: respostaRpc(id, resultado) };
    } catch (err: any) {
      return { resposta: respostaRpc(id, textoResultado(`Falha inesperada ao executar ${nomeFerramenta}: ${err?.message || String(err)}. Informe o usuário da falha temporária.`, true)) };
    }
  }

  if (method === 'ping') {
    return { resposta: respostaRpc(id, {}) };
  }

  // Notificações (mensagens sem id): não geram resposta
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      const nome = params?.clientInfo?.name || req.headers.get('x-ia-copiloto-nome') || 'I.A. via MCP';
      return { notificacao: true, registrarCopiloto: nome };
    }
    return { notificacao: true };
  }

  return { resposta: erroRpc(id, -32601, `Método não encontrado: ${method}`) };
}

async function registrarCopilotoMcp(nome: string, req: Request, cf: any): Promise<void> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const apiKey = `sk_ia_${Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')}`;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  const apiKeyHash = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  await registrarCopilotoSupabase({
    nome,
    apiKeyHash,
    prefix: apiKey.substring(0, 8),
    metadata: {
      via: 'mcp',
      endpoint: new URL(req.url).pathname,
      user_agent: req.headers.get('user-agent') || 'desconhecido',
      telemetria_rede: {
        provedor_ia: cf?.asOrganization || 'desconhecido',
        pais: cf?.country || null,
        cidade: cf?.city || null,
        datacenter_cloudflare: cf?.colo || null
      }
    }
  });
}

async function lidarComPost(astro: any): Promise<Response> {
  const req: Request = astro.request;
  const cf: any = astro.locals?.runtime?.cf || {};

  let corpo: any;
  try {
    corpo = await req.json();
  } catch {
    return new Response(JSON.stringify(erroRpc(null, -32700, 'Erro ao interpretar JSON')), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...HEADERS_CORS }
    });
  }

  const mensagens = Array.isArray(corpo) ? corpo : [corpo];
  if (mensagens.length === 0) {
    return new Response(JSON.stringify(erroRpc(null, -32600, 'Requisição inválida')), {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...HEADERS_CORS }
    });
  }

  const respostas: any[] = [];
  const headersResposta: Record<string, string> = {};
  let soNotificacoes = true;

  for (const mensagem of mensagens) {
    const processado = await processarMensagem(mensagem, req);

    if (processado.resposta) {
      if (processado.headers) {
        for (const [chave, valor] of Object.entries(processado.headers)) {
          if (!headersResposta[chave]) headersResposta[chave] = valor;
        }
      }
      respostas.push(processado.resposta);
      soNotificacoes = false;
    } else if (processado.registrarCopiloto) {
      headersResposta['x-ia-copiloto-nome'] = encodeURIComponent(processado.registrarCopiloto);
      try {
        await registrarCopilotoMcp(processado.registrarCopiloto, req, cf);
      } catch (e) {
        console.error('[MCP] Erro ao registrar copiloto:', e);
      }
    }
  }

  if (soNotificacoes) {
    return new Response(null, { status: 202, headers: { ...HEADERS_CORS, ...headersResposta } });
  }

  const corpoFinal = respostas.length === 1 ? respostas[0] : respostas;
  return new Response(JSON.stringify(corpoFinal), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...HEADERS_CORS, ...headersResposta }
  });
}

export const GET: any = async () => {
  // Transporte Streamable HTTP: GET abriria stream servidor→cliente, que não usamos.
  return new Response(JSON.stringify({
    servidor: 'sensacional-mcp',
    transporte: 'streamable-http',
    instrucao: 'Envie mensagens JSON-RPC 2.0 via POST para este endpoint (Accept: application/json). Ferramentas: abrir_necessidade, buscar_profissionais, ver_necessidade. Guia: https://ai.sensacional.site/conectar'
  }), { status: 405, headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS', ...HEADERS_CORS } });
};

export const POST: any = async (astro: any) => {
  try {
    return await lidarComPost(astro);
  } catch (err: any) {
    console.error('[MCP] Erro interno:', err);
    return new Response(JSON.stringify(erroRpc(null, -32603, `Erro interno do servidor: ${err?.message || String(err)}`)), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...HEADERS_CORS }
    });
  }
};

export const OPTIONS: any = async () => {
  return new Response(null, { status: 204, headers: HEADERS_CORS });
};

export const ALL: any = async () => {
  return new Response(JSON.stringify(erroRpc(null, -32600, 'Método não suportado. Use POST (JSON-RPC 2.0).')), {
    status: 405,
    headers: { 'Content-Type': 'application/json', Allow: 'POST, OPTIONS', ...HEADERS_CORS }
  });
};
