/**
 * Utilitário para invocação do Cloudflare Worker via Service Binding de alta velocidade.
 * 
 * Na Cloudflare Edge (produção), utiliza `locals.runtime.env.EVERMIND_WORKER.fetch` diretamente
 * sobre a rede interna da Cloudflare (sem latência de DNS / SSL público).
 * 
 * Em ambiente local de desenvolvimento ou fallback, faz requisição HTTP padrão para o domínio público.
 */

export function isWorkerBindingDisponivel(locals?: App.Locals): boolean {
  const worker = locals?.runtime?.env?.EVERMIND_WORKER;
  return typeof worker?.fetch === 'function';
}

export async function chamarWorkerBinding(
  locals: App.Locals | undefined,
  path: string,
  init?: RequestInit
): Promise<Response> {
  const worker = locals?.runtime?.env?.EVERMIND_WORKER;

  if (worker && typeof worker.fetch === 'function') {
    // Chamada direta de altíssima velocidade via Cloudflare Edge Service Binding
    const internalUrl = path.startsWith('http')
      ? path
      : `https://internal${path.startsWith('/') ? '' : '/'}${path}`;
    
    return await worker.fetch(new Request(internalUrl, init));
  }

  // Fallback transparente em dev local ou ambiente fora do runtime Cloudflare
  const baseUrl = 'https://ai.sensacional.site';
  const targetUrl = path.startsWith('http')
    ? path
    : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;

  return await fetch(targetUrl, init);
}
