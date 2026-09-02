export interface PayloadIA {
  api_key?: string;
  id_necessidade?: string;
  descricao_necessidade?: string;
  urgencia?: string;
  cidade?: string;
  bairro?: string;
  prazo_inicio?: string;
  prazo_conclusao?: string;
  canal_origem?: string;
  privado?: boolean;
  etapa?: number | string;
  nome?: string;
  composicao?: any;
  [key: string]: unknown;
}

/**
 * Decodifica o parâmetro `corpo-url`.
 * Tenta decodificar Base64 -> JSON.
 * Se falhar, tenta JSON.parse direto.
 * Se não for JSON válido, retorna como texto em `descricao_necessidade`.
 * 
 * REGRA: Nunca duplicar dados. Um único campo `descricao_necessidade` para texto.
 */
export function decodificarPayloadUrl(rawInput: string | null): PayloadIA | null {
  if (!rawInput) return null;

  const trimmed = rawInput.trim();
  if (!trimmed) return null;

  // 1. Tentar como Base64
  try {
    let base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const decodedText = new TextDecoder('utf-8').decode(bytes);
    const jsonParsed = JSON.parse(decodedText);
    if (typeof jsonParsed === 'object' && jsonParsed !== null) {
      return normalizarPayload(jsonParsed);
    }
  } catch (_e) {
    // Não é Base64 válido ou o conteúdo decodificado não é JSON
  }

  // 2. Tentar como JSON direto (caso não venha em Base64)
  try {
    const directJson = JSON.parse(trimmed);
    if (typeof directJson === 'object' && directJson !== null) {
      return normalizarPayload(directJson);
    }
  } catch (_e) {
    // Não é JSON puro
  }

  // 3. Fallback: Texto puro → vira descricao_necessidade (SEM duplicação)
  return {
    descricao_necessidade: trimmed,
  };
}

/**
 * Normaliza campos legados para o padrão atual.
 * Converte nomes antigos para os atuais, sem duplicar dados.
 */
function normalizarPayload(obj: any): PayloadIA {
  const normalizado: PayloadIA = { ...obj };

  // Normalizar campos de descrição para UM único campo
  if (!normalizado.descricao_necessidade) {
    normalizado.descricao_necessidade = obj.descricao || obj.raw_texto || obj.resumo || null;
  }
  // Limpar campos legados redundantes do objeto
  delete normalizado.descricao;
  delete normalizado.raw_texto;
  delete normalizado.resumo;

  // Normalizar localidade aninhada para campos diretos
  if (obj.localidade && typeof obj.localidade === 'object') {
    if (!normalizado.cidade && obj.localidade.cidade) normalizado.cidade = obj.localidade.cidade;
    if (!normalizado.bairro && obj.localidade.bairro) normalizado.bairro = obj.localidade.bairro;
    delete normalizado.localidade;
  }

  // Normalizar ID legado
  if (!normalizado.id_necessidade && obj.necessidade_id) {
    normalizado.id_necessidade = obj.necessidade_id;
    delete normalizado.necessidade_id;
  }

  return normalizado;
}

/**
 * Codifica um objeto JSON para Base64 URL-safe.
 */
export function codificarPayloadUrl(payload: PayloadIA): string {
  const jsonString = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(jsonString);
  let binaryString = '';
  for (let i = 0; i < bytes.length; i++) {
    binaryString += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binaryString);
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
