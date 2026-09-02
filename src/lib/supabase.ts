export const SUPABASE_URL = 'https://tcxhuryqrzidvrltjhiz.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Xz1PSjOLImkMDkF3waRw1g_EAl1DiZ1';

export function gerarApiKeyIa(): { apiKey: string; prefix: string } {
  const randomHex = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const apiKey = `sk_ia_${randomHex}`;
  const prefix = apiKey.substring(0, 8);
  return { apiKey, prefix };
}

export async function calcularHashApiKey(apiKey: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(apiKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function registrarCopilotoSupabase(params: {
  nome: string;
  apiKeyHash: string;
  prefix: string;
  metadata?: any;
}): Promise<boolean> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/ia_copiloto`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        nome: params.nome,
        api_key_hash: params.apiKeyHash,
        api_key_prefix: params.prefix,
        ativo: true,
        metadata: params.metadata || {}
      })
    });
    if (!response.ok) {
      const errBody = await response.text();
      console.error('[Supabase] Erro ao registrar copiloto:', response.status, errBody);
    }
    return response.ok;
  } catch (err) {
    console.error('[Supabase] Erro ao registrar copiloto:', err);
    return false;
  }
}

/**
 * Normaliza valores de urgência estritamente para os 4 valores nativos do PostgreSQL enum:
 * 'baixa' | 'media' | 'alta' | 'emergencia'
 */
function normalizarUrgencia(valor: string | undefined | null): string {
  if (!valor) return 'media';
  const v = valor.toLowerCase().trim();

  // Valores nativos aceitos pelo Postgres urgencia_enum original
  if (v === 'baixa') return 'baixa';
  if (v === 'media') return 'media';
  if (v === 'alta') return 'alta';
  if (v === 'emergencia') return 'emergencia';

  // Mapeamento de termos comuns/I.A. para os 4 valores nativos do Enum
  if (v === 'urgente' || v === 'critica' || v === 'imediata' || v === 'sos') return 'emergencia';
  if (v === 'agendado' || v === 'agenda' || v === 'marcado' || v === 'futuro') return 'baixa';
  if (v === 'importante' || v === 'prioritaria') return 'alta';
  if (v === 'quando_puder' || v === 'sem_pressa') return 'baixa';
  if (v === 'normal' || v === 'moderada' || v === 'padrao') return 'media';

  return 'media';
}

export interface FiltrosPessoas {
  busca?: string;
  profissoes?: string[];
  habilidades?: string[];
  cidade?: string;
  idadeMin?: number;
  idadeMax?: number;
  criadoApos?: string;
  criadoAte?: string;
  ativoApos?: string;
  precoMin?: number;
  precoMax?: number;
  atendeEmergencia?: boolean;
  apenasPublicados?: boolean;
  limite?: number;
  offset?: number;
}

export interface PessoaEncontrada {
  id: string;
  codigo_publico: string;
  nome_publico: string;
  slug: string;
  titulo: string;
  bio: string;
  avatar_url: string;
  profissoes: string[];
  cidade: string;
  estado: string;
  idade: number;
  atende_emergencia: boolean;
  indice_confianca: number;
  jobs_concluidos: number;
  verificacao_identidade: string;
  ultima_atividade_em: string;
  habilidades: Array<{
    id: string; nome: string; slug: string; tipo_preco: string;
    preco_min: number; preco_max: number;
    nome_metrica: string; valor_metrica: number;
  }>;
  total: number;
}

/**
 * Busca profissionais no banco via RPC listar_pessoas.
 * Todos os filtros são opcionais e combináveis (E lógico entre categorias).
 */
export async function listarPessoas(filtros: FiltrosPessoas): Promise<{
  sucesso: boolean;
  pessoas: PessoaEncontrada[];
  erro?: string;
}> {
  const corpo: Record<string, any> = {};
  if (filtros.busca) corpo.p_busca = filtros.busca;
  if (filtros.profissoes?.length) corpo.p_profissoes = filtros.profissoes;
  if (filtros.habilidades?.length) corpo.p_habilidades = filtros.habilidades;
  if (filtros.cidade) corpo.p_cidade = filtros.cidade;
  if (filtros.idadeMin != null) corpo.p_idade_min = filtros.idadeMin;
  if (filtros.idadeMax != null) corpo.p_idade_max = filtros.idadeMax;
  if (filtros.criadoApos) corpo.p_criado_apos = filtros.criadoApos;
  if (filtros.criadoAte) corpo.p_criado_ate = filtros.criadoAte;
  if (filtros.ativoApos) corpo.p_ativo_apos = filtros.ativoApos;
  if (filtros.precoMin != null) corpo.p_preco_min = filtros.precoMin;
  if (filtros.precoMax != null) corpo.p_preco_max = filtros.precoMax;
  if (typeof filtros.atendeEmergencia === 'boolean') corpo.p_atende_emergencia = filtros.atendeEmergencia;
  if (typeof filtros.apenasPublicados === 'boolean') corpo.p_apenas_publicados = filtros.apenasPublicados;
  if (filtros.limite != null) corpo.p_limite = filtros.limite;
  if (filtros.offset != null) corpo.p_offset = filtros.offset;

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/listar_pessoas`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(corpo)
    });
    if (!response.ok) {
      const erro = await response.text();
      console.error('[Supabase] Erro listar_pessoas:', response.status, erro);
      return { sucesso: false, pessoas: [], erro: `Erro ${response.status}: ${erro}` };
    }
    const pessoas = await response.json();
    return { sucesso: true, pessoas: Array.isArray(pessoas) ? pessoas : [] };
  } catch (err: any) {
    console.error('[Supabase] Erro listar_pessoas:', err);
    return { sucesso: false, pessoas: [], erro: err?.message || String(err) };
  }
}

export interface ResultadoSalvarNecessidade {
  id: string;
  status: string;
  isNew: boolean;
  dbSuccess: boolean;
  httpStatus?: number;
  dbErrorDetails?: string;
  payloadEnviadoBanco?: any;
}

export async function salvarOuAtualizarNecessidade(params: {
  idNecessidade?: string | null;
  apiKey?: string;
  iaCopilotoId?: string | null;
  descricao: string;
  mensagemOrigem?: string | null;
  urgencia?: string;
  cidade?: string;
  bairro?: string;
  canalOrigem?: string;
  prazoInicio?: string | null;
  prazoConclusao?: string | null;
  requerVistoria?: boolean;
  composicao?: any;
  midias?: any;
  payloadCompleto?: any;
}): Promise<ResultadoSalvarNecessidade> {
  const idUsado = (params.idNecessidade && params.idNecessidade.length > 8)
    ? params.idNecessidade
    : crypto.randomUUID();

  const isNew = !params.idNecessidade || params.idNecessidade.length <= 8;
  const urgenciaNormalizada = normalizarUrgencia(params.urgencia);

  const dadosEnvio: Record<string, any> = {
    id: idUsado,
    descricao_necessidade: params.descricao || 'Necessidade enviada por I.A.',
    mensagem_origem: params.mensagemOrigem || (typeof params.payloadCompleto === 'string' ? params.payloadCompleto : JSON.stringify(params.payloadCompleto || {})),
    urgencia: urgenciaNormalizada,
    status: 'pendente',
    cidade: params.cidade || null,
    bairro: params.bairro || null,
    canal_origem: params.canalOrigem || 'site de i.a',
    ia_copiloto_id: params.iaCopilotoId || null,
    prazo_inicio: params.prazoInicio || null,
    prazo_conclusao: params.prazoConclusao || null,
    requer_vistoria: typeof params.requerVistoria === 'boolean' ? params.requerVistoria : false,
    composicao: params.composicao || {},
    midias: params.midias || []
  };

  try {
    // Usamos UPSERT do Supabase (resolution=merge-duplicates) para evitar erro 409 de chave duplicada
    const resUpsert = await fetch(`${SUPABASE_URL}/rest/v1/necessidade`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates,return=representation'
      },
      body: JSON.stringify(dadosEnvio)
    });

    if (resUpsert.ok) {
      const bodyInsert = await resUpsert.json();
      if (bodyInsert && bodyInsert.length > 0) {
        return {
          id: bodyInsert[0].id,
          status: bodyInsert[0].status || 'pendente',
          isNew: isNew,
          dbSuccess: true,
          httpStatus: resUpsert.status,
          payloadEnviadoBanco: dadosEnvio
        };
      }
    } else {
      const errText = await resUpsert.text();
      return {
        id: idUsado,
        status: 'pendente',
        isNew: isNew,
        dbSuccess: false,
        httpStatus: resUpsert.status,
        dbErrorDetails: `Erro UPSERT (${resUpsert.status}): ${errText}`,
        payloadEnviadoBanco: dadosEnvio
      };
    }
  } catch (err: any) {
    return {
      id: idUsado,
      status: 'pendente',
      isNew: isNew,
      dbSuccess: false,
      dbErrorDetails: `Exception JS: ${err?.message || String(err)}`,
      payloadEnviadoBanco: dadosEnvio
    };
  }

  return {
    id: idUsado,
    status: 'pendente',
    isNew: isNew,
    dbSuccess: false,
    dbErrorDetails: 'Nenhum retorno recebido da API Supabase REST',
    payloadEnviadoBanco: dadosEnvio
  };
}
