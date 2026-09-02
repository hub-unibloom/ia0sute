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

### Regras de conduta para a I.A.

- Vá um passo de cada vez. Não invente dados.
- Não prometa orçamento, prazo ou diagnóstico que a API não confirmou.
- A escolha do prestador é SEMPRE do usuário.

### Exemplo de conexão rápida (Claude Code)

claude mcp add --transport http sensacional https://ai.sensacional.site/mcp
`;

  return new Response(texto, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
};

export { GET };
