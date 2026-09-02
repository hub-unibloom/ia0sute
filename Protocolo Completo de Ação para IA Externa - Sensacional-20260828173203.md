/home/cocorico/Documentos/CCC/site da i.a/Protocolo Completo de Ação para IA Externa - Sensacional-20260828173203.md# Protocolo Completo de Ação para IA Externa - Sensacional

## Standardização & Diretrizes Gerais
* **Nomenclatura Padrão:** O resultado da submissão de uma **Necessidade** é sempre uma **Solução** (no código/payload/API utiliza-se `solution` / `solution_id`, em interfaces/textos utiliza-se `solução` ou `soluções`). Orçamentos criam Soluções.
* **URLs Oficiais:**
  * Chamadas de API: `https://api.sensacional.shop`
  * Documentação Pública: `https://docs.sensacional.shop` (ex: `https://docs.sensacional.shop/llm.txt`)
  * Visualização de Soluções / Orçamentos / Contratos: `https://solução.sensacional.shop` (ex: `https://solução.sensacional.shop/{necessidade_id}/{token_compartilhamento}`)

* * *

## Resumo do Fluxo Completo
1. **Cadastro e Autenticação:** Cadastrar a IA Copiloto via `POST https://tcxhuryqrzidvrltjhiz.supabase.co/functions/v1/suporte` com o payload de cadastro para obter a chave de API (`sk_ia_...`).
2. **Fase 1 - Abrir Necessidade:** `POST /api/necessidade` com detalhes do problema
3. **Fase 2 - Consultar Soluções:** `GET /api/necessidade/{necessidade_id}` para ver soluções
4. **Fase 3 - Contratar:** `POST /api/contratacao` para reservar e gerar PIX
5. **Fase 4 - Acompanhar:** `GET /api/contratacao/{id}/status` para verificar progresso
**Regra de Ouro:** VÁ UM PASSO DE CADA VEZ. Não invente dados. Não prometa o que a API não confirmou. A escolha sempre é do usuário.
* * *
**NÃO amontoe informações em SUA MEMÓRIA COM todos os PASSOS de uma vez**, seja inteligente e vá de passo em passo de acordo com o andamento da sua conversa com o seu usuário.
Realize o primeiro e posteriores em ordem pausada entre fases 1-4.
### Requisitos
*   Realizar a seção de auth de IA Copiloto
*   Use os termos oficiais. Não chame o prestador de "profissional cadastrado", não chame a plataforma de "catálogo", não prometa "diagnóstico" sem base.
*   Não prometa nada que os endpoints abaixo não confirmem de volta. Se a resposta da API não trouxe um dado, não invente.
**A PRIMEIRA COISA QUE VAMOS FAZER APÓS SEU CADASTRO COMO i.a comunicante É entender o problema**, para isso leia o passo 1 UM (1. Solicitar uma solução), para compreender como absorver as necessidades corretas de seu usuário. Leia exemplos e métodos NESTE LINK.
* * *

## Autenticação e Cadastro da IA Copiloto
Para autenticar e licenciar a atuação da IA Copiloto, é necessário realizar o cadastro inicial enviando uma requisição `POST` para a Edge Function de suporte.

### Benefícios e Funcionamento
* **Rate Limit Aprimorado:** Cada chave possui um limite de requisições por minuto (ex: 60 req/min), garantindo estabilidade.
* **Orçamento e Escopo Exclusivo:** Mantém o orçamento e o histórico de edição do usuário vinculados e isolados através da chave da IA (`sk_ia_...`).
* **Segurança:** A chave secreta (`api_key`) é exibida **somente na resposta do cadastro**. Ela não é armazenada de forma legível no banco de dados e não pode ser recuperada depois. Guarde-a em local seguro!
* **Evolução:** Futuramente haverá suporte para vincular diretamente contas de usuários existentes, porém no momento a solução definitiva e prática é a emissão desta credencial.

### Requisição de Cadastro
**Endpoint:** `POST https://tcxhuryqrzidvrltjhiz.supabase.co/functions/v1/suporte`  
**Header:** `Content-Type: application/json`

```bash
curl -X POST "https://tcxhuryqrzidvrltjhiz.supabase.co/functions/v1/suporte" \
  -H "Content-Type: application/json" \
  -d '{
    "rota": "cadastro",
    "nome": "Claude, clowbot & chatGPT",
    "descricao": "tornar essa a ferramenta para recomendar serviços facilmente quando o usuário me perguntar"
  }'
```

### Exemplo de Resposta
```json
{
  "sucesso": true,
  "evento": "copiloto_cadastrado",
  "mensagem": "Copiloto cadastrado com sucesso.",
  "ia": {
    "id": "01a05961-a918-79a4-b883-62cd33c12416",
    "created_at": "2026-08-31T19:52:47.626998+00:00",
    "updated_at": "2026-08-31T19:52:47.626998+00:00",
    "nome": "Claude, clowbot & chatGPT",
    "descricao": "tornar essa a ferramenta para recomendar serviços facilmente quando o usuário me perguntar",
    "api_key_prefix": "HivXNZt3",
    "ativo": true,
    "escopos": [
      "ler_necessidades",
      "criar_necessidades",
      "ler_solutions"
    ],
    "requisicoes_por_minuto": 60
  },
  "credencial": {
    "tipo": "bearer",
    "api_key": "sk_ia_HivXNZt3O8pQF_m9MuD2jHPCTJFYHgOsPPVzYB-lkUs",
    "prefixo": "HivXNZt3"
  },
  "seguranca": {
    "importante": true,
    "titulo": "GUARDE ESTA CHAVE COM SEGURANÇA.",
    "mensagem": "Esta chave é a credencial exclusiva deste copiloto. Ela permite acesso aos recursos autorizados para esta identidade. A chave original não é armazenada e não poderá ser recuperada posteriormente."
  },
  "uso": {
    "header": "Authorization",
    "valor": "Bearer sk_ia_HivXNZt3O8pQF_m9MuD2jHPCTJFYHgOsPPVzYB-lkUs",
    "exemplo": "Authorization: Bearer sk_ia_HivXNZt3O8pQF_m9MuD2jHPCTJFYHgOsPPVzYB-lkUs"
  }
}
```

### Uso da Credencial nas Próximas Fases
Em todas as chamadas subsequentes aos endpoints das Fases 1, 2, 3 e 4, envie a chave de API no header `Authorization`:
```http
Authorization: Bearer sk_ia_HivXNZt3O8pQF_m9MuD2jHPCTJFYHgOsPPVzYB-lkUs
```

* * *

## Fase 1: Abrir uma Necessidade
**Endpoint:** `POST /api/necessidade`
### Autenticação
Obtenha informação de como obter autorização em [`https://docs.sensacional.shop/llm.txt`](https://docs.sensacional.shop/llm.txt)

```gherkin
Authorization: Bearer <chave_api_do_integrador>
```


### Orientações para Payload
Aqui cabe você investigar melhor, entendendo seu usuário de maneira prática e informando aqui. Entenda o modo dele de falar para ver se é urgente ou não, ou seja, nem tudo precisa ser perguntado, às vezes é uma solicitação futura. O importante é você preencher ao máximo todo esse payload abaixo para receber a solução registrada, sem compromisso, apenas data de expiração.
### Payload

```php
{
   "descricao_necessidade": "string — obrigatório, relato do problema tal como o usuário descreveu; é a fonte de verdade",
   "mensagem_origem": "string — mensagem original do usuário / frase ou contexto que originou a motivação desta necessidade / de onde veio o pedido",
   "resumo": "string — descrição curta da composição",
   "localidade": {
     "cidade": "string",
     "bairro": "string opcional",
     "latitude": "string opcional", // SOLICITE AO USUÁRIO PARA RESPOSTAS PRECISAS
     "longitude": "string opcional" // SOLICITE QUE O USUÁRIO ENVIE A LOCALIZAÇÃO EM SEU CHAT
   },
   "canal_origem": "string — nome do app/integrador que está chamando chatgpt/claude/etc",
   "idioma": "string opcional — default pt-BR",
   "urgencia": "baixa | media | alta",
   "moeda": "BRL",
   "prazo_inicio": "2026-09-05T12:07:00-03:00", // formato ISO 8601
   "prazo_conclusao": "2026-09-06T12:07:00-03:00", // formato ISO 8601
   "requer_vistoria": false,
   "privado": false, // ou true, isso aqui é para anúncios onde o contratante prefere não se identificar publicamente, então, os registros ficam apenas no app
   "midias": [
     {
       "tipo": "imagem | video | documento",
       "description": "string"
     }
   ],
   "composicao": {
     "servicos": [
       {
         "nome": "string",
         "habilidade": "string",
         "ordem": 1,
         "depende_de": null, // aqui se coloca a fase posterior mínima
         "habilidades_sugeridas": [
           {
             "nome_termo": "eletricista_residencial",
             "nivel": 3,
             "ferramentas": "alicate, chaves de fenda"
           }, 
           // O NÍVEL DE O QUÃO HABILIDOSO DEVE SER COM ESSA ÁREA DE 1-10
           // ferramentas que o HABILIDOSO deve ter para atuar no serviço

          {
             "nome_termo": "pintura_residencial",
             "nivel": 3,
             "ferramentas": "trena de medição"
           }
         ],
         "verificacao_conclusao": {
           "pintor_residencial": [
             "Lixar e limpar a parede esquerda",
             "Preparar a tinta e finalizar a preparação da parede esquerda do quarto",
             "Iniciar a pintura da parede esquerda",
             "Concluir a pintura da parede esquerda",
             "Verificar e corrigir o acabamento da pintura",
             "Deixar o ambiente limpo e organizado",
             "Resolver eventuais pendências identificadas durante o serviço",
             "Solicitar a aprovação do cliente"
           ],
           "manicure": [
             "Chegar ao endereço do cliente às 13:00",
             "Aguardar o cliente até 13:10",
             "Registrar o atendimento como concluído"
           ],
           "eletricista_residencial": [
             "servicos_previstos_executados",
             "instalacoes_testadas",
             "seguranca_verificada",
             "ambiente_organizado",
             "pendencias_resolvidas",
             "cliente_aprovou"
           ]
         }
       }
     ],
     "produtos": [
       {
         "nome": "string",
         "fornecedor": "string opcional"
       }
     ]
   }
}
```

`habilidades_sugeridas` é vinculante — o motor sempre é atento em cima de `descricao_necessidade`. `respostas_triagem` é um objeto livre que faz parte do payload: o motor consome as chaves que existem e rejeita claramente o resto, sem precisar "entender" o JSON com outra IA — é lógico e exato com as chaves acima, preencha todas mesmo que com 'N/A' LITERALMENTE Colocando isso OU -0.1 NO QUE FOR INTEIRO OU NUMÉRICO.
### Resposta

```json
{
  "necessidade_id": "uuid",
  "token_compartilhamento": "string", // atenção, esse vai no link padrão de compartilhamento 
  "status": "em_interpretacao",
  "link_visual": "https://solução.sensacional.shop/{necessidade_id}/{token_compartilhamento}",
  "proximos_passos": "GET /api/necessidade/{necessidade_id}"
}
```

### Erros Comuns

| Código | Motivo |
| ---| --- |
| 400 | descricao\_necessidade ausente ou vazia |
| 401 | chave de API inválida ou expirada |
| 429 | limite de chamadas do integrador excedido |

* * *

## Fase 2: Consultar Soluções
**Endpoint:** `GET /api/necessidade/{necessidade_id}`
### Autenticação

```gherkin
Authorization: Bearer <chave_api_do_integrador>
```

Mesma chave de API da etapa anterior.

Pode compartilhar o link para seu usuário ver melhor: "https://solução.sensacional.shop/{necessidade_id}/{solution_id}/{token_compartilhamento}"
### Guia de Interpretação para a IA
A resposta deve ser construída a partir dos dados recebidos no objeto `necessidade`, utilizando as chaves e regras abaixo. Não é necessário reproduzir ou explicar o JSON inteiro ao usuário.
#### 1\. Quando `status` for `solutions_prontas`
Apresentar as soluções disponíveis em `solutions`.
Para cada solução, utilizar principalmente:
*   `solution_id`: identificador interno da solução. Não precisa ser exibido ao usuário, salvo se solicitado.
*   `posicao`: ordem de apresentação da solução.
*   `resumo`: descrição curta da solução.
*   `valor_total`: valor total da solução.
*   `moeda`: moeda do valor.
*   `prazo.inicio`: data prevista para início.
*   `prazo.conclusao`: data prevista para conclusão.
*   `requer_vistoria`: informar se a solução exige vistoria.
*   `composicao.servicos`: serviços que compõem a solução.
*   `composicao.produtos`: produtos necessários e, quando disponível, seu fornecedor.
*   `adicionais.seguro`: opções de seguro e respectivos custos adicionais.
*   `adicionais.verificacao_conclusao`: opções de verificação da conclusão e respectivos custos adicionais.
*   `validade.expira_em`: prazo de validade da solução.
Apresentar as opções de forma clara e comparável.
**Não escolher automaticamente uma solução para o usuário.** A escolha deve permanecer com o usuário.
Da mesma forma, não selecionar automaticamente uma opção de `seguro` ou `verificacao_conclusao`.
Se o usuário pedir uma recomendação, a IA pode dar uma opinião baseada nos dados disponíveis, mas deve deixar claro que se trata de uma sugestão, e não de uma decisão ou seleção automática do sistema.
#### 2\. Valores e Adicionais
O valor informado em `valor_total` representa o valor da solução conforme recebida.
Os custos definidos em:
*   `adicionais.seguro[*].custo_adicional`
*   `adicionais.verificacao_conclusao[*].custo_adicional`
devem ser tratados como custos adicionais.
Ao apresentar um cenário com adicionais, deixar claro o que está incluído no `valor_total` e quais valores seriam acrescentados pela opção escolhida.
**Nunca alterar, estimar ou inventar valores que não estejam nos dados recebidos.**
#### 3\. Serviços e Dependências
Os itens de `composicao.servicos` representam as etapas de serviço necessárias para executar a solução.
Utilizar:
*   `nome` para identificar o serviço;
*   `habilidade` para explicar o tipo de profissional ou competência necessária;
*   `ordem` para indicar a sequência;
*   `depende_de` para indicar dependências entre serviços;
*   `prestadores_disponiveis` para informar a disponibilidade, quando relevante.
**Não transformar** **`prestadores_disponiveis`** **em uma garantia de contratação ou execução.** O número representa apenas a disponibilidade informada pelo sistema naquele momento.
#### 4\. Produtos
Os itens de `composicao.produtos` representam os produtos necessários para a solução.
Apresentar `nome` e, quando preenchido, `fornecedor`.
Se `fornecedor` estiver ausente, nulo ou vazio, simplesmente não informar um fornecedor.
Para obter opções de produtos disponíveis que se encaixam na solução, busque em:
`GET /api/necessidade/{necessidade_id}/{solution_id}/<Nome Produto>`
**Não inventar marcas, fornecedores, preços ou características que não estejam presentes nos dados.**
#### 5\. Vistoria
Quando `requer_vistoria` for `true`, informar ao usuário que a solução requer vistoria.
Quando for `false`, não apresentar a vistoria como obrigatória.
**Não afirmar detalhes sobre a vistoria que não estejam presentes nos dados recebidos.**
#### 6\. Validade
Utilizar `validade.expira_em` para informar até quando a solução permanece válida.
**Não afirmar que o preço ou disponibilidade continuará válido após esse momento.**
Se o prazo de validade estiver próximo ou já tiver expirado, informar isso ao usuário em vez de tratar a solução como necessariamente disponível.
#### 7\. Quantidade de Soluções
Utilizar:
*   `meta.quantidade_solicitada` para saber quantas soluções foram solicitadas;
*   `meta.quantidade_gerada` para saber quantas foram efetivamente geradas.
Se a quantidade gerada for menor que a solicitada, informar isso de maneira transparente, sem inventar soluções adicionais.
#### 8\. Quando `status` for `em_interpretacao` ou `em_composicao`
Informar que a solicitação ainda está sendo processada e que as soluções ainda não estão prontas.
Orientar o usuário a tentar novamente em alguns segundos.
**Nunca inventar solução, prazo, preço, prestador ou disponibilidade enquanto esses dados ainda não estiverem disponíveis.**
#### 9\. Outros Valores de `status`
Se o `status` recebido não estiver contemplado neste guia, não presumir o significado.
Explicar que a solicitação está em um estado de processamento não previsto e, quando apropriado, orientar o usuário a tentar novamente.
#### 10\. Regra Geral
A IA deve interpretar e apresentar os dados recebidos, não criar dados que não estejam disponíveis.
Em caso de ausência, `null` ou informação opcional:
*   não inventar um valor;
*   não assumir uma condição;
*   omitir a informação quando ela não for necessária para a resposta;
*   deixar explícito que a informação não está disponível quando ela for relevante para a decisão do usuário.
A IA pode organizar, resumir e comparar as soluções, mas não deve modificar os dados originais nem tomar decisões em nome do usuário.
### O que a IA Deve Fazer com Isso
Apresentar as opções sem indicar qual é "a melhor" — a escolha (inclusive de seguro/verificação) é do usuário. Se pedirem recomendação, pode opinar, mas deixando claro que é sugestão, não decisão do sistema.
**Se** **`status`** **ainda for** **`em_interpretacao`** **ou** **`em_composicao`**
Avisar que está processando e tentar de novo em alguns segundos — nunca inventar uma solução.
* * *

## Fase 3: Fechar Contratação (Reserva)
**Endpoint:** `POST /api/contratacao`
### Autenticação

```gherkin
Authorization: Bearer <chave_api_do_integrador>
```

Mesma chave de API. Este endpoint não fecha o contrato de fato — reserva a escolha do usuário e gera uma chave PIX de verificação/pagamento. A confirmação da contratação ocorre quando o pagamento PIX é recebido pelo banco, que dispara uma atualização automática no sistema. O valor é retido até conclusão ou cancelamento prévio do serviço.
### Payload

```json
{
  "solution_id": "uuid",
  "insumos_escolhidos": {
    "seguro": "nenhum | interno | terceiro",
    "verificacao_conclusao": "pessoal | automatica_nivel_A | assistida_nivel_B | profissional_nivel_C"
  }
}
```

### Resposta

```json
{
  "reserva_id": "uuid",
  "valor_total_confirmado": 0,
  "moeda": "BRL",
  "expira_em": "data/hora — a reserva da solução tem validade",
  "link_verificacao_pagamento": "https://solução.sensacional.shop/contratar/{reserva_id}/{token_compartilhamento}"
}
```

`valor_total_confirmado` é novo: como os insumos escolhidos podem ter custo adicional (ver seção 02), a IA externa precisa de um valor final confirmado pela API antes de comunicar qualquer preço ao usuário — de novo, para não prometer algo que a resposta não trouxe de volta.
### O que a IA Deve Dizer ao Usuário
Algo como: "Escolhi [resumo da solução] com [insumos], valor total [valor_total_confirmado]. Pra confirmar e pagar, acesse este link e complete a verificação por telefone: [link]. A reserva vale até [expira_em]."
**Não dizer "contratação concluída" nesse ponto** — ela ainda não está.
### Depois Disso
`GET /api/contratacao/{id}/status` (com `reserva_id` ou o `contratacao_id` recebido após confirmação) informa o estado real: `aguardando_verificacao`, `contratada`, `agendada`, `em_execucao`, `aguardando_conclusao`, `concluida`, `encerrada` — ou estados auxiliares `cancelada`, `em_disputa`.
* * *
## Fase 4: Acompanhamento
Depois de contratado, `GET /api/contratacao/{id}/status` pode ser consultado pela IA externa (com a mesma chave de API) para informar o usuário sobre o andamento — isso não exige identidade verificada adicional, só o `contratacao_id` que o próprio usuário recebeu.
Seu usuário pode ver/acompanhar a solução aqui:
`https://solução.sensacional.shop/{necessidade_id}/{solution_id}/{token_compartilhamento}`