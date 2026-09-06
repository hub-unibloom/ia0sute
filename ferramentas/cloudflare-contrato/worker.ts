import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

export interface Env {
  BUCKET_CONTRATOS: R2Bucket;
  ENVIRONMENT?: string;
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Token-Gestao, X-Api-Key',
};

function responderJson(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

function sanitizarPath(str: string): string {
  if (!str) return 'indefinido';
  return str
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9_\-\s]/g, '_')  // preserva letras, números, hífen, underline e espaço temporariamente
    .trim()
    .replace(/\s+/g, '_')           // converte espaços em _
    .replace(/_+/g, '_')            // remove _ duplicados
    .substring(0, 100);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Trata Preflight CORS
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 1. Rota de download direto do R2 mantendo estrutura hierárquica
      if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
        const key = decodeURIComponent(url.pathname.replace('/download/', ''));
        if (!key) {
          return responderJson({ sucesso: false, erro: 'Chave do arquivo não fornecida' }, 400);
        }

        const object = await env.BUCKET_CONTRATOS.get(key);
        if (!object) {
          return responderJson({ sucesso: false, erro: 'Arquivo não encontrado no storage' }, 404);
        }

        const headers = new Headers(corsHeaders);
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Content-Type', object.httpMetadata?.contentType || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

        return new Response(object.body, { headers });
      }

      // 2. Rota POST principal para geração, versão e assinaturas de contratos
      if (request.method === 'POST') {
        const body: any = await request.json();

        const documentoUrl = body.documento_url;
        if (!documentoUrl) {
          return responderJson({
            sucesso: false,
            erro: 'campo_obrigatorio_ausente',
            mensagem: 'O campo "documento_url" com o link do contrato base é obrigatório.',
          }, 400);
        }

        // --- Organização Hierárquica por API Key / Projeto / Serviço / Versão ---
        const apiKey = request.headers.get('X-Api-Key') || body.api_key || 'api_key_padrao';
        const projeto = body.projeto || 'projeto_geral';
        const servico = body.servico || 'servico_unico';
        const versao = body.versao || '1.0';
        const nomeContrato = body.nome_contrato || 'contrato';

        const apiKeyPath = sanitizarPath(apiKey);
        const projetoPath = sanitizarPath(projeto);
        const servicoPath = sanitizarPath(servico);
        const versaoFormatted = `v${String(versao).trim().replace(/^v/i, '')}`;
        const versaoPath = sanitizarPath(versaoFormatted);
        const nomeContratoSanitizado = sanitizarPath(nomeContrato);

        // --- Construção do Sufixo de Assinaturas (Ex: "assinatura de carlos - assinatura de vinicius") ---
        let sufixoAssinaturas = '';
        if (body.sufixo_assinaturas && typeof body.sufixo_assinaturas === 'string') {
          sufixoAssinaturas = body.sufixo_assinaturas;
        } else if (Array.isArray(body.signatarios) && body.signatarios.length > 0) {
          const partesAssinantes = body.signatarios.map((s: any) => {
            const nomeSignatario = typeof s === 'object' && s.nome ? s.nome : String(s);
            return `assinatura de ${nomeSignatario}`;
          });
          sufixoAssinaturas = partesAssinantes.join(' - ');
        } else if (Array.isArray(body.assinaturas) && body.assinaturas.length > 0) {
          const partesAssinantes = body.assinaturas.map((a: any) => {
            const nome = typeof a === 'object' && a.nome ? a.nome : String(a);
            return `assinatura de ${nome}`;
          });
          sufixoAssinaturas = partesAssinantes.join(' - ');
        }

        const sufixoAssinaturasSanitizado = sufixoAssinaturas ? sanitizarPath(sufixoAssinaturas) : '';

        // --- Extração de Variáveis (Tags <...>) ---
        let variaveis: Record<string, any> = {};
        if (body.variaveis && typeof body.variaveis === 'object') {
          variaveis = { ...body.variaveis };
        } else {
          const chavesReservadas = [
            'documento_url', 'nome_contrato', 'api_key', 'projeto', 
            'servico', 'versao', 'secoes_adicionais', 'substituicoes_texto',
            'signatarios', 'assinaturas', 'sufixo_assinaturas'
          ];
          for (const key of Object.keys(body)) {
            if (!chavesReservadas.includes(key)) {
              variaveis[key] = body[key];
            }
          }
        }

        // Seções adicionais injetadas
        if (Array.isArray(body.secoes_adicionais)) {
          variaveis['secoes_adicionais'] = body.secoes_adicionais;
        }

        // 3. Download do arquivo DOCX base
        const docxResponse = await fetch(documentoUrl);
        if (!docxResponse.ok) {
          return responderJson({
            sucesso: false,
            erro: 'erro_download_base',
            mensagem: `Não foi possível baixar o contrato base da URL informada. Status HTTP: ${docxResponse.status}`,
          }, 400);
        }

        const contentArrayBuffer = await docxResponse.arrayBuffer();

        // 4. Processa o DOCX com PizZip e Docxtemplater
        const zip = new PizZip(contentArrayBuffer);
        
        // Nível 1: Substituição de tags <nome-do-campo>
        const doc = new Docxtemplater(zip, {
          delimiters: { start: '<', end: '>' },
          paragraphLoop: true,
          linebreaks: true,
        });

        doc.render(variaveis);

        // Nível 2: Substituições de Texto Brutais / Linha / Frases Específicas
        if (Array.isArray(body.substituicoes_texto) && body.substituicoes_texto.length > 0) {
          const zipRef = doc.getZip();
          let documentXml = zipRef.file('word/document.xml')?.asText();

          if (documentXml) {
            for (const sub of body.substituicoes_texto) {
              if (sub.buscar && sub.substituir_por !== undefined) {
                const buscaEscapada = sub.buscar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(buscaEscapada, 'g');
                documentXml = documentXml.replace(regex, sub.substituir_por);
              }
            }
            zipRef.file('word/document.xml', documentXml);
          }
        }

        // Nível 3: Adição de Seções/Cláusulas novas no final do corpo do XML
        if (Array.isArray(body.secoes_adicionais) && body.secoes_adicionais.length > 0) {
          const zipRef = doc.getZip();
          let documentXml = zipRef.file('word/document.xml')?.asText();

          if (documentXml && documentXml.includes('</w:body>')) {
            let blocoNovasSecoes = '';
            for (const secao of body.secoes_adicionais) {
              const titulo = secao.titulo || 'Nova Cláusula';
              const conteudo = secao.conteudo || '';
              blocoNovasSecoes += `
                <w:p>
                  <w:pPr><w:pStyle w:val="Heading1"/></w:pPr>
                  <w:r><w:rPr><w:b/></w:rPr><w:t>${titulo}</w:t></w:r>
                </w:p>
                <w:p>
                  <w:r><w:t>${conteudo}</w:t></w:r>
                </w:p>`;
            }
            documentXml = documentXml.replace('</w:body>', `${blocoNovasSecoes}</w:body>`);
            zipRef.file('word/document.xml', documentXml);
          }
        }

        // Gera o arquivo DOCX finalizado como Uint8Array
        const outputBuf = doc.getZip().generate({
          type: 'uint8array',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        });

        // 5. Construção do Nome do Arquivo conforme o pedido explícito:
        // Exemplo de resultado:
        // "contrato_400028922_de_eletricista_para_moises_terca_feira_21_de_setembro_v1.1_assinatura_de_carlos.docx"
        // "contrato_400028922_de_eletricista_para_moises_terca_feira_21_de_setembro_v1.2_assinatura_de_carlos_-_assinatura_de_vinicius.docx"
        
        let nomeArquivoFinal = `${nomeContratoSanitizado}_${versaoPath}`;
        if (sufixoAssinaturasSanitizado) {
          nomeArquivoFinal += `_${sufixoAssinaturasSanitizado}`;
        }
        nomeArquivoFinal += `.docx`;

        const fileKey = `contratos/${apiKeyPath}/${projetoPath}/${servicoPath}/${versaoPath}/${nomeArquivoFinal}`;

        await env.BUCKET_CONTRATOS.put(fileKey, outputBuf, {
          httpMetadata: {
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          },
          customMetadata: {
            apiKey: apiKeyPath,
            projeto: projetoPath,
            servico: servicoPath,
            versao: versaoPath,
            sufixoAssinaturas: sufixoAssinaturas,
            criadoEm: new Date().toISOString(),
          },
        });

        const publicDownloadUrl = `${url.origin}/download/${encodeURIComponent(fileKey)}`;

        return responderJson({
          sucesso: true,
          mensagem: 'Contrato gerado com versao e status de assinaturas no nome do arquivo',
          hierarquia: {
            api_key: apiKeyPath,
            projeto: projetoPath,
            servico: servicoPath,
            versao: versaoPath,
          },
          contrato: {
            nome_contrato: nomeContrato,
            versao: versaoFormatted,
            sufixo_assinaturas: sufixoAssinaturas,
            nome_arquivo_final: nomeArquivoFinal,
            file_key: fileKey,
            download_url: publicDownloadUrl,
            variaveis_substituidas: Object.keys(variaveis).length,
            substituicoes_texto_aplicadas: Array.isArray(body.substituicoes_texto) ? body.substituicoes_texto.length : 0,
            secoes_adicionadas: Array.isArray(body.secoes_adicionais) ? body.secoes_adicionais.length : 0,
            criado_em: new Date().toISOString(),
          },
        }, 201);
      }

      // Rota default
      return responderJson({
        sucesso: true,
        mensagem: 'Worker de Geração e Assinatura de Contratos Dinâmicos (Versionamento com Assinantes) Ativo.',
        endpoints: {
          gerar_contrato: 'POST /',
          download_contrato: 'GET /download/{file_key}',
        },
      });
    } catch (error: any) {
      console.error('Erro no processamento do contrato:', error);
      return responderJson({
        sucesso: false,
        erro: 'erro_interno_geracao',
        mensagem: error.message || 'Erro inesperado ao gerar contrato',
      }, 500);
    }
  },
};
