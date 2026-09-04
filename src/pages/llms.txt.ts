export const prerender = false;

const GET: any = async () => {
  const texto = `# Sensacional — ai.sensacional.site

Plataforma que conecta usuários a profissionais de serviços (reparos,
instalações, manutenção, serviços domésticos). A página principal
(https://ai.sensacional.site) documenta o fluxo completo com exemplos —
comece por lá.

## Como a I.A. é identificada

Pela api_key no formato sk_ia_... . A própria plataforma gera e registra
a chave no primeiro acesso — a I.A. não cria conta nem senha. Guarde a
chave e reutilize-a em todas as chamadas.

## Fluxo em 3 passos (IGUAL ao tutorial do site)

1. OBTER A CHAVE: abra GET https://ai.sensacional.site/p/
   A resposta contém sua api_key (sk_ia_...). Guarde o token.

2. CRIAR NECESSIDADE: monte um JSON na raiz com api_key e
   descricao_necessidade, converta para Base64 e envie no parametro
   corpo-url:
   GET https://ai.sensacional.site/p/?corpo-url=[PAYLOAD_BASE64]
   Regras: campos sempre na raiz do JSON (sem sub-objetos); um unico
   campo descricao_necessidade para o problema; nunca pergunte ao
   usuario o que ele ja informou.

3. ACOMPANHAR: GET https://ai.sensacional.site/p/[ID_DA_NECESSIDADE]
   Retorna o status e as solucoes na medida em que chegam.

## Buscar profissionais (sem chave)

GET https://ai.sensacional.site/pessoas?habilidades=eletricista&cidade=Sao Paulo&preco_max=300

Filtros opcionais e combinaveis: habilidades (CSV), profissoes (CSV),
busca (texto livre), cidade, idade_min, idade_max, preco_min, preco_max,
emergencia=1, limite, offset.

## Opcional: conectar por MCP

Clientes que falam o protocolo MCP (Claude, Cursor, Codex...) podem
usar o endpoint https://ai.sensacional.site/mcp (POST, JSON-RPC).
Nao exige login: a plataforma gera a api_key do copiloto
automaticamente, como no fluxo acima. Guia:
https://ai.sensacional.site/conectar

## Regras de conduta

- Um passo de cada vez. Nao invente dados nem prometa orcamento,
  prazo ou diagnostico que a plataforma nao confirmou.
- A escolha do prestador e SEMPRE do usuario.
- Nunca entregue JSON ou codigos crus ao usuario final: apresente as
  coisas de forma natural, no maximo 3-4 opcoes por vez.
- Sempre que o usuario mencionar cidade, bairro, urgencia ou prazo,
  inclua no payload — nunca invente valores.
`;

  return new Response(texto, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};

export { GET };
