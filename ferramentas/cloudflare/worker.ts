/**
 * Cloudflare Worker Ultra-Rápido & Coletor de Telemetria de I.A.
 * Captura dados avançados de rede, provedor, fuso, latência e User-Agent da I.A.
 * e salva em segundo plano no Supabase para análise comportamental.
 */

const SUPABASE_URL = 'https://tcxhuryqrzidvrltjhiz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Xz1PSjOLImkMDkF3waRw1g_EAl1DiZ1';

function normalizarUrgencia(valor: string | undefined | null): string {
  if (!valor) return 'media';
  const v = valor.toLowerCase().trim();
  if (v === 'baixa') return 'baixa';
  if (v === 'media') return 'media';
  if (v === 'alta') return 'alta';
  if (v === 'emergencia') return 'emergencia';
  if (v === 'urgente' || v === 'critica' || v === 'imediata' || v === 'sos') return 'emergencia';
  if (v === 'agendado' || v === 'agenda' || v === 'marcado' || v === 'futuro') return 'baixa';
  if (v === 'importante' || v === 'prioritaria') return 'alta';
  if (v === 'quando_puder' || v === 'sem_pressa') return 'baixa';
  if (v === 'normal' || v === 'moderada' || v === 'padrao') return 'media';
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

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corpoUrlRaw = url.searchParams.get('corpo-url');

    // === EXTRAÇÃO DE TELEMETRIA RICA DE BORDA (CLOUDFLARE EDGE) ===
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

    if (corpoUrlRaw) {
      let payloadObj: any = null;
      let formatoFormatoPayload = 'texto_puro';

      try {
        const decodedText = decodeBase64Utf8(corpoUrlRaw);
        payloadObj = JSON.parse(decodedText);
        formatoFormatoPayload = 'base64_json';
      } catch (_e) {
        try {
          payloadObj = JSON.parse(corpoUrlRaw);
          formatoFormatoPayload = 'json_direto';
        } catch (_e2) {
          payloadObj = { descricao_necessidade: corpoUrlRaw };
          formatoFormatoPayload = 'texto_puro';
        }
      }

      const descNecessidade = payloadObj?.descricao_necessidade || payloadObj?.descricao || payloadObj?.raw_texto || null;
      const nomeCopiloto = payloadObj?.nome || payloadObj?.canal_origem || descNecessidade || 'Copiloto I.A. Desconhecido';
      let idNecessidade = payloadObj?.id_necessidade || payloadObj?.id || null;
      const apiKeyEnviada = payloadObj?.api_key || request.headers.get('x-ia-api-key') || null;

      // Se não veio ID mas veio descrição, geramos um UUID v4 no Worker imediatamente
      if (!idNecessidade && descNecessidade) {
        idNecessidade = crypto.randomUUID();
      }

      const aninhamentoIncorreto = Boolean(payloadObj?.payload || payloadObj?.dados || payloadObj?.corpo || payloadObj?.body);

      let apiKeyUsada = apiKeyEnviada;
      let isNovaChave = false;

      if (!apiKeyUsada) {
        const randomBytes = crypto.getRandomValues(new Uint8Array(16));
        const hexString = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        apiKeyUsada = `sk_ia_${hexString}`;
        isNovaChave = true;
      }

      const prefix = apiKeyUsada.substring(0, 8);
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKeyUsada));
      const apiKeyHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

      const metadataCompleto = {
        telemetria_rede: telemetriaBorda,
        comportamento: {
          formato_envio: formatoFormatoPayload,
          tamanho_bytes: corpoUrlRaw.length,
          aninhamento_incorreto: aninhamentoIncorreto,
          chaves_enviadas: payloadObj ? Object.keys(payloadObj) : [],
          is_primeira_chamada: isNovaChave
        },
        payload_origem: payloadObj,
        url_requisicao: request.url
      };

      // 1. Grava Copiloto no Supabase
      ctx.waitUntil(
        fetch(`${SUPABASE_URL}/rest/v1/ia_copiloto`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            nome: nomeCopiloto,
            api_key_hash: apiKeyHash,
            api_key_prefix: prefix,
            ativo: true,
            metadata: metadataCompleto
          })
        }).catch(err => console.error('[Worker] Erro Supabase ia_copiloto:', err))
      );

      // 2. Se há necessidade a ser salva, grava imediatamente no Supabase (non-blocking) com UPSERT
      if (descNecessidade && idNecessidade) {
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
              urgencia: normalizarUrgencia(payloadObj?.urgencia),
              cidade: payloadObj?.cidade || null,
              bairro: payloadObj?.bairro || null,
              status: 'pendente',
              mensagem_origem: JSON.stringify(payloadObj)
            })
          }).catch(err => console.error('[Worker] Erro Supabase necessidade:', err))
        );
      }

      // Repassa dados via Headers para o Astro SSR
      const modifiedHeaders = new Headers(request.headers);
      modifiedHeaders.set('x-ia-api-key', apiKeyUsada);
      modifiedHeaders.set('x-ia-is-nova-chave', isNovaChave ? '1' : '0');
      modifiedHeaders.set('x-ia-copiloto-nome', encodeURIComponent(nomeCopiloto));
      modifiedHeaders.set('x-ia-provedor', encodeURIComponent(telemetriaBorda.provedor_ia));
      modifiedHeaders.set('x-ia-pais', telemetriaBorda.pais_servidor);
      modifiedHeaders.set('x-ia-datacenter', telemetriaBorda.datacenter_cloudflare);

      if (idNecessidade) {
        modifiedHeaders.set('x-ia-id-necessidade', idNecessidade);
      }

      return fetch(new Request(request, { headers: modifiedHeaders }));
    }

    return fetch(request);
  }
};
