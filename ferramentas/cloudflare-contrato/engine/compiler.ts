export interface ContractPayload {
  api_key?: string;
  projeto?: string;
  servico?: string;
  versao?: string;
  nome_contrato?: string;
  documento_url?: string;
  
  fatos?: Record<string, any>;
  partes?: Array<Record<string, any>>;
  modulos?: Record<string, any>;
  variaveis?: Record<string, any>;
  
  secoes_adicionais?: Array<{ titulo: string, conteudo: string }>;
  substituicoes_texto?: Array<{ buscar: string, substituir_por: string }>;
  
  signatarios?: any[];
  assinaturas?: any[];
  sufixo_assinaturas?: string;
}

export function compilarContextoDocx(payload: ContractPayload): Record<string, any> {
  const fatos = payload.fatos || {};
  const modulos = payload.modulos || {};
  
  // O contexto base recebe as variáveis limpas e as partes em formato de lista (Array) para loops {#partes}...{/partes}
  const context: Record<string, any> = {
    ...payload.variaveis,
    partes: payload.partes || [],
  };

  // --- AVALIAÇÃO DE FATOS E ÁRVORE DE DEPENDÊNCIAS JURÍDICAS ---

  // 1. Pagamento e Preço
  if (fatos.tem_pagamento || modulos.pagamento) {
    context.has_pagamento = true;
    context.pagamento = modulos.pagamento || {};
  } else {
    context.has_pagamento = false;
  }

  // 2. Confidencialidade (NDA)
  if (fatos.exige_sigilo || fatos.tem_informacao_confidencial || modulos.nda) {
    context.has_nda = true;
    context.nda = modulos.nda || {};
    // Dependência: Se não forneceu prazo, o padrão é 5 anos (exigência de sobrevivência)
    if (!context.nda.prazo_anos) {
      context.nda.prazo_anos = 5;
    }
  } else {
    context.has_nda = false;
  }

  // 3. Proteção de Dados (LGPD / DPA)
  if (fatos.trata_dados_pessoais || modulos.lgpd) {
    context.has_lgpd = true;
    context.lgpd = modulos.lgpd || {};
    if (!context.lgpd.papel) {
      context.lgpd.papel = 'operador';
    }
  } else {
    context.has_lgpd = false;
  }

  // 4. Propriedade Intelectual (Software, Design, etc.)
  if (fatos.cria_propriedade_intelectual || fatos.envolve_software || modulos.ip) {
    context.has_ip = true;
    context.ip = modulos.ip || {};
  } else {
    context.has_ip = false;
  }

  // 5. SLA e Risco Operacional
  if (fatos.risco_operacional === 'alto' || fatos.risco_operacional === 'critico' || modulos.sla) {
    context.has_sla = true;
    context.sla = modulos.sla || {};
  } else {
    context.has_sla = false;
  }

  // 6. Aceite e Entregáveis (Definition of Done)
  if (fatos.exige_aceite_formal || fatos.tem_entregaveis || modulos.aceite) {
    context.has_aceite = true;
    context.aceite = modulos.aceite || {};
  } else {
    context.has_aceite = false;
  }

  // 7. Rescisão / Terminação
  if (modulos.rescisao) {
    context.has_rescisao = true;
    context.rescisao = modulos.rescisao;
  } else {
    context.has_rescisao = true; // Geralmente padrão
    context.rescisao = { dias_aviso_previo: 30 };
  }

  // Permite injetar outros módulos genéricos que venham da IA
  for (const [key, value] of Object.entries(modulos)) {
    if (!context[`has_${key}`]) {
      context[`has_${key}`] = true;
      context[key] = value;
    }
  }

  return context;
}
