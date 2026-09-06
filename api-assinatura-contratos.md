# Mapa de API — Sistema de Assinatura de Contratos

Referência técnica dos endpoints que o backend (Cloudflare Functions) expõe. O frontend (construído no AI Studio) consome só isso — nunca fala direto com R2/D1.

## Convenção de nomes

| Termo | Significado |
|---|---|
| `contrato_id` | ID interno do contrato (UUID) |
| `token_gestao` | Token opaco que o **criador** do contrato usa pra acompanhar status — como não há login, esse token é o "acesso de dono" (guardar/favoritar o link) |
| `signatario_id` | ID interno de um signatário específico |
| `token_assinatura` | Token opaco único por **signatário** — é o link que ele recebe pra assinar |

⚠️ Ponto de decisão que ainda não tínhamos fechado: como não tem login, o criador do contrato precisa de *algum* jeito de voltar depois e ver o status geral (quem já assinou, quem falta). A solução mais simples é gerar, junto com o contrato, um `token_gestao` — um segundo link, separado dos links de assinatura, que só o criador recebe. Ele não aparece em lugar nenhum pros signatários.

---

## 1. Criar contrato

`POST /api/contratos`

Recebe o arquivo, extrai as variáveis, cria o registro em rascunho.

**Request** (multipart/form-data)
```
arquivo: File (.docx ou .odt)
nome_contrato: string (opcional, só rótulo pro criador)
```

**Response 201**
```json
{
  "contrato_id": "ctr_8f2a...",
  "token_gestao": "tkg_92hd...",
  "tipo_arquivo": "docx",
  "variaveis_encontradas": ["nome_cliente", "valor_total", "data_inicio"],
  "status": "rascunho"
}
```

**Erros**
- `400` — arquivo não é docx/odt, ou nenhuma variável `<...>` encontrada
- `413` — arquivo excede tamanho máximo

---

## 2. Preencher variáveis

`PATCH /api/contratos/{contrato_id}/variaveis`

**Auth:** header `X-Token-Gestao`

**Request**
```json
{
  "variaveis": {
    "nome_cliente": "João da Silva",
    "valor_total": "R$ 3.500,00",
    "data_inicio": "10/09/2026"
  }
}
```

**Response 200**
```json
{
  "contrato_id": "ctr_8f2a...",
  "variaveis_preenchidas": 3,
  "variaveis_faltando": [],
  "pronto_para_signatarios": true
}
```

---

## 3. Cadastrar signatários

`POST /api/contratos/{contrato_id}/signatarios`

**Auth:** header `X-Token-Gestao`

**Request**
```json
{
  "signatarios": [
    {
      "nome": "João da Silva",
      "contato": "joao@email.com",
      "tipo_contato": "email",
      "tipo_confirmacao": "selfie"
    },
    {
      "nome": "Maria Souza",
      "contato": "5561999990000",
      "tipo_contato": "telefone",
      "tipo_confirmacao": "simples"
    }
  ]
}
```

`tipo_confirmacao` aceita: `simples` | `selfie` | `documento` | `selfie_documento`

**Response 201**
```json
{
  "signatarios": [
    {
      "signatario_id": "sig_a1b2...",
      "nome": "João da Silva",
      "token_assinatura": "tka_x9z1...",
      "link": "https://seusite.com/assinar/tka_x9z1..."
    },
    {
      "signatario_id": "sig_c3d4...",
      "nome": "Maria Souza",
      "token_assinatura": "tka_m7n8...",
      "link": "https://seusite.com/assinar/tka_m7n8..."
    }
  ]
}
```

---

## 4. Ativar contrato

`POST /api/contratos/{contrato_id}/ativar`

**Auth:** header `X-Token-Gestao`

Valida que todas as variáveis estão preenchidas e há ao menos 1 signatário. Gera o documento final (variáveis substituídas), salva no R2, muda status pra `ativo`. A partir daqui os links de assinatura passam a funcionar.

**Response 200**
```json
{
  "contrato_id": "ctr_8f2a...",
  "status": "ativo",
  "ativado_em": 1757030400
}
```

**Erros**
- `409` — ainda faltam variáveis ou não há signatários cadastrados

---

## 5. Status geral do contrato (visão do criador)

`GET /api/contratos/{contrato_id}`

**Auth:** header `X-Token-Gestao`

**Response 200**
```json
{
  "contrato_id": "ctr_8f2a...",
  "nome_contrato": "Prestação de serviço - João",
  "status": "ativo",
  "expira_em": 1764806400,
  "signatarios": [
    { "signatario_id": "sig_a1b2...", "nome": "João da Silva", "status": "assinado", "assinado_em": 1757100000 },
    { "signatario_id": "sig_c3d4...", "nome": "Maria Souza", "status": "pendente" }
  ]
}
```

---

## 6. Abrir link de assinatura (visão do signatário)

`GET /api/assinar/{token_assinatura}`

Sem autenticação além do próprio token (é o link opaco que faz esse papel). Esse endpoint também **registra evento de auditoria** (`visualizou`).

**Response 200**
```json
{
  "nome_contrato": "Prestação de serviço - João",
  "nome_signatario": "João da Silva",
  "documento_url": "https://r2-signed-url.../doc.pdf?exp=...",
  "tipo_confirmacao": "selfie",
  "status": "pendente"
}
```

**Erros**
- `404` — token inválido
- `410` — contrato expirado (passou dos 90 dias) ou já cancelado

---

## 7. Enviar verificação (selfie / documento)

`POST /api/assinar/{token_assinatura}/verificacao`

Só necessário se `tipo_confirmacao` exigir. Endpoint separado da assinatura em si, pra o frontend poder mostrar "verificação ok ✓" antes do passo final.

**Request** (multipart/form-data)
```
selfie: File (opcional, conforme tipo_confirmacao)
documento: File (opcional, conforme tipo_confirmacao)
```

**Response 200**
```json
{
  "status": "verificado"
}
```

---

## 8. Assinar

`POST /api/assinar/{token_assinatura}`

**Request**
```json
{
  "nome_confirmado": "João da Silva",
  "aceite": true
}
```

Server-side, nesse momento: valida que a verificação (se exigida) já foi concluída, grava na auditoria (`hash_documento`, `ip`, `user_agent`, `timestamp`), marca o signatário como `assinado`. Se for o último signatário pendente, o contrato inteiro vira `concluido` e o documento final consolidado (com todas as evidências) é gerado.

**Response 200**
```json
{
  "status": "assinado",
  "download_url": "https://r2-signed-url.../final-assinado.pdf?exp=..."
}
```

**Erros**
- `409` — verificação exigida ainda não foi concluída
- `410` — token expirado ou contrato já cancelado

---

## 9. Baixar documento (a qualquer momento após assinar)

`GET /api/assinar/{token_assinatura}/documento`

Redireciona (302) pra uma signed URL do R2 com expiração curta — nunca serve link permanente direto.

---

## 10. Auditoria completa do contrato

`GET /api/contratos/{contrato_id}/auditoria`

**Auth:** header `X-Token-Gestao`

**Response 200**
```json
{
  "eventos": [
    { "signatario_id": "sig_a1b2...", "tipo_evento": "visualizou", "timestamp": 1757099000, "ip": "200.1.2.3" },
    { "signatario_id": "sig_a1b2...", "tipo_evento": "upload_selfie", "timestamp": 1757099500, "ip": "200.1.2.3" },
    { "signatario_id": "sig_a1b2...", "tipo_evento": "assinou", "timestamp": 1757100000, "ip": "200.1.2.3", "hash_documento": "sha256:..." }
  ]
}
```

---

## Resumo da tabela de rotas

| Método | Rota | Quem acessa | Auth |
|---|---|---|---|
| POST | `/api/contratos` | Criador | — |
| PATCH | `/api/contratos/{id}/variaveis` | Criador | `X-Token-Gestao` |
| POST | `/api/contratos/{id}/signatarios` | Criador | `X-Token-Gestao` |
| POST | `/api/contratos/{id}/ativar` | Criador | `X-Token-Gestao` |
| GET | `/api/contratos/{id}` | Criador | `X-Token-Gestao` |
| GET | `/api/contratos/{id}/auditoria` | Criador | `X-Token-Gestao` |
| GET | `/api/assinar/{token}` | Signatário | token na URL |
| POST | `/api/assinar/{token}/verificacao` | Signatário | token na URL |
| POST | `/api/assinar/{token}` | Signatário | token na URL |
| GET | `/api/assinar/{token}/documento` | Signatário | token na URL |
