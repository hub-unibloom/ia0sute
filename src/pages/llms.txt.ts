export const prerender = false;

const GET: any = async () => {
  const texto = `# Sensacional — site da I.A.

A plataforma Sensacional conecta usuários reais a profissionais de serviços
(domésticos, reparos, instalações, manutenção). I.As copiloto podem abrir
necessidades, buscar profissionais e acompanhar andamentos.

## Servidor MCP (Model Context Protocol)

- URL do endpoint: https://ai.sensacional.site/mcp
- Transporte: Streamable HTTP (JSON-RPC 2.0)
- Autenticação: NENHUMA exigida (sem login, sem credenciais). A I.A. é
  identificada pelo nome que informa em clientInfo no initialize.
- Guia de conexão: https://ai.sensacional.site/conectar

### Ferramentas disponíveis

1. abrir_necessidade — registra uma necessidade real do usuário.
   Argumentos: descricao_necessidade (obrigatório), urgencia
   (baixa|media|alta|emergencia), cidade, bairro, prazo_inicio,
   prazo_conclusao, id_necessidade (para atualizar), nome_copiloto.
   Retorna: id_necessidade, status, url_acompanhamento.

2. buscar_profissionais — busca profissionais reais cadastrados.
   Argumentos (todos opcionais): busca, cidade, profissoes[], habilidades[],
   preco_min, preco_max, atende_emergencia, limite (1-20), offset.
   Retorna: lista de pessoas com nome, título, profissões, cidade e url_perfil.

3. ver_necessidade — consulta status de uma necessidade aberta.
   Argumentos: id (obrigatório, UUID retornado por abrir_necessidade).
   Retorna: status, urgencia, descricao, url_acompanhamento.

4. cadastrar_item — cadastra uma oferta (produto ou serviço) em nome de um
   profissional ou loja. Variedades em tipo_oferta: habilidade (o que a
   pessoa sabe fazer), item_fisico (produto com estoque), item_virtual
   (produto digital) e servico (trabalho sob demanda). Modelos de preço em
   tipo_preco: fixo, a_partir_de, faixa (preco_min+preco_max), por_metrica
   (nome_metrica + valor_metrica) e sob_orcamento. Dono: profissional_id,
   loja_id ou codigo_publico. Padrão: nasce como rascunho; use
   status "publicado" para ficar visível.

5. buscar_itens — busca ofertas publicadas. Argumentos (opcionais): busca,
   tipo_oferta, categoria, preco_max, limite.

### Regras de conduta para a I.A.

- Tom de mordomo profissional: leve, simples, sempre presente e pronto
  para ajudar do início ao fim.
- Proatividade: nunca peça ao usuário para nomear algo do zero. Sugira
  opções de resposta a partir do que ele já disse no chat. Ao cadastrar
  uma habilidade, ofereça cadastrar também o serviço com preço; ao abrir
  uma necessidade, ofereça buscar profissionais. Uma pergunta por vez.
- Campos úteis: sempre que o usuário mencionar cidade, bairro, urgência,
  prazo, preço, estoque ou contato, inclua no campo correspondente da
  ferramenta. Nunca invente valores que o usuário não informou.
- Formatação (REGRA ABSOLUTA): NUNCA entregue JSON ou códigos crus ao
  usuário final. Apresente os dados de forma natural e sem sobrecarga,
  no máximo 3-4 opções por vez.
- Vá um passo de cada vez. Não invente dados.
- Não prometa orçamento, prazo ou diagnóstico que a ferramenta não confirmou.
- A escolha do prestador é SEMPRE do usuário.

### Exemplo de conexão rápida (Claude Code)

claude mcp add --transport http sensacional https://ai.sensacional.site/mcp
`;

  return new Response(texto, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};

export { GET };
