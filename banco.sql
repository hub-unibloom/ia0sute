-- =============================================================================
-- SENSACIONAL — SCHEMA V6 (CONSOLIDADO FINAL)
-- Supabase/PostgreSQL 15+
--
-- Objetivos desta versão:
--   1. catálogo de serviços, problemas, sinônimos e localidades;
--   2. páginas indexáveis por serviço/localidade e perfis profissionais;
--   3. confiança sem exigir avaliações de profissionais novos;
--   4. favoritos e vistos recentemente para itens, profissionais e lojas;
--   5. necessidade, solução, contratação, pagamento, divisão e avaliação;
--   6. dados prontos para feeds de negócios e integrações de necessidade por IA;
--   7. identidade central conectando WhatsApp, web e Supabase Auth;
--   8. RPCs internas protegidas por GRANT/REVOKE explícitos;
--   9. autorização compartilhada de comandas e dados financeiros;
--  10. limitação persistente de tentativas por remetente verificado;
--  11. autenticação, licenciamento e auditoria para IAs copiloto externas.
--
-- IMPORTANTE:
--   - este arquivo é para banco novo no Supabase; não é migration;
--   - avaliações são opcionais e nunca condicionam a publicação inicial;
--   - RLS fica habilitado, mas sem policies. service_role/backend acessa; clientes
--     diretos precisam de policies definidas quando a autenticação for escolhida.
-- =============================================================================
BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Schema e extensão para normalização de busca textual (sem acentos)
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA extensions;

-- =============================================================================
-- FUNÇÕES UTILITÁRIAS
-- =============================================================================
CREATE OR REPLACE FUNCTION public.uuidv7() RETURNS uuid
LANGUAGE sql VOLATILE PARALLEL SAFE AS $$
SELECT encode(
  set_bit(
    set_bit(
      overlay(
        uuid_send(gen_random_uuid())
        placing substring(
          int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint)
          FROM 3
        )
        FROM 1 FOR 6
      ),
      52, 1
    ),
    53, 1
  ),
  'hex'
)::uuid;
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Atualiza updated_at em tabelas de acervo do prestador (mídia e credenciais)
CREATE OR REPLACE FUNCTION public.atualizar_timestamp_acervo_prestador()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.slug_valido(valor text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
SELECT valor ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$';
$$;

-- Normaliza texto comercial para comparação sem acentos; não interpreta intenção nem problemas.
CREATE OR REPLACE FUNCTION public.normalizar_busca(valor text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public, extensions
AS $function$
  SELECT trim(
    regexp_replace(
      lower(unaccent('unaccent', coalesce(valor, ''))),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$function$;

-- =============================================================================
-- TIPOS
-- =============================================================================
-- 'habilidade': capacidade atômica que o prestador declara e vende direto
-- (o coração do modelo — cadastro livre, preço próprio, matching por embedding).
-- 'servico': reservado pra quando existir composição de várias habilidades
-- numa entrega só (ex: "reforma de banheiro" = elétrica + hidráulica + pintura);
-- sem linhas desse tipo ainda, sem mecanismo de composição construído.
CREATE TYPE public.tipo_oferta_enum AS ENUM (
  'habilidade', 'item_fisico', 'item_virtual', 'servico'
);
CREATE TYPE public.nome_metrica_enum AS ENUM (
  'peso', 'minuto', 'hora', 'km', 'empreitada', 'm2', 'm3', 'unidade'
);
CREATE TYPE public.tipo_preco_enum AS ENUM (
  'fixo', 'a_partir_de', 'faixa', 'por_metrica', 'sob_orcamento'
);
CREATE TYPE public.status_verificacao_enum AS ENUM (
  'nao_iniciada', 'pendente', 'verificado', 'rejeitado', 'expirado'
);
CREATE TYPE public.status_publicacao_enum AS ENUM (
  'rascunho', 'em_revisao', 'publicado', 'suspenso', 'arquivado'
);
CREATE TYPE public.tipo_pagina_seo_enum AS ENUM (
  'home', 'servico', 'servico_localidade', 'profissional', 'loja', 'conteudo'
);
CREATE TYPE public.urgencia_enum AS ENUM (
  'baixa', 'media', 'alta', 'emergencia'
);

-- =============================================================================
-- USUÁRIOS E IDENTIDADES EXTERNAS
-- =============================================================================
CREATE TABLE public.user_perfil (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  -- Pode começar NULL quando o perfil nasce no WhatsApp. Ao autenticar na
  -- web, passa a apontar para o único usuário Supabase Auth daquela pessoa.
  auth_user_id     uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  nome             varchar(100),
  cpf              varchar(11),
  apelido          varchar(30),
  data_nascimento  date,
  avatar_url       text,
  locale           varchar(10) DEFAULT 'pt-BR',
  system_nick_name text,
  system_nick_id   text,
  ativo            boolean NOT NULL DEFAULT true,
  CONSTRAINT user_perfil_cpf_check CHECK (cpf IS NULL OR cpf ~ '^[0-9]{11}$')
);
CREATE UNIQUE INDEX uq_user_perfil_cpf
  ON public.user_perfil (cpf) WHERE cpf IS NOT NULL;
CREATE INDEX idx_user_perfil_auth_user
  ON public.user_perfil (auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE TRIGGER trg_user_perfil_updated_at
  BEFORE UPDATE ON public.user_perfil
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.user_identidade (
  id                    uuid PRIMARY KEY DEFAULT public.uuidv7(),
  perfil_id             uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  canal                 varchar(20) NOT NULL CHECK (canal IN (
    'whatsapp', 'telegram', 'instagram',
    'google', 'apple', 'email'
  )),
  extern_id             varchar(255) NOT NULL,
  contato_normalizado   varchar(255),
  email                 varchar(255),
  nome_canal            varchar(100),
  avatar_url            text,
  locale                varchar(10),
  criado_em             timestamptz NOT NULL DEFAULT now(),
  verificado_em         timestamptz,
  ultima_utilizacao_em  timestamptz,
  revogado_em           timestamptz,
  revogado_por          uuid REFERENCES public.user_perfil(id) ON DELETE SET NULL,
  system_nick_name      text,
  system_nick_id        text
);
CREATE INDEX idx_user_identidade_perfil
  ON public.user_identidade (perfil_id);
CREATE UNIQUE INDEX uq_user_identidade_ativa
  ON public.user_identidade (canal, extern_id)
  WHERE revogado_em IS NULL;
CREATE INDEX idx_user_identidade_contato
  ON public.user_identidade (canal, contato_normalizado)
  WHERE revogado_em IS NULL AND contato_normalizado IS NOT NULL;

-- Registro auditável do aceite de documentos legais por um perfil autenticado.
CREATE TABLE public.aceite_legal (
  id             uuid PRIMARY KEY DEFAULT public.uuidv7(),
  user_perfil_id uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  tipo           varchar(30) NOT NULL CHECK (tipo IN ('termos_uso', 'politica_privacidade')),
  versao         varchar(40) NOT NULL,
  contexto       varchar(20) NOT NULL CHECK (contexto IN ('cliente', 'prestador')),
  aceito_em      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT aceite_legal_perfil_tipo_versao_contexto_uk
    UNIQUE (user_perfil_id, tipo, versao, contexto)
);
CREATE INDEX aceite_legal_perfil_aceito_idx
  ON public.aceite_legal (user_perfil_id, aceito_em DESC);

-- Código criado por um usuário já autenticado na web para continuar a
-- vinculação em WhatsApp/Telegram. Apenas o hash fica persistido.
CREATE TABLE public.solicitacao_vinculo_identidade (
  id                    uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  perfil_id             uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  auth_user_id          uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  canal                 varchar(20) NOT NULL CHECK (canal IN ('whatsapp', 'telegram')),
  codigo_hash           varchar(64) NOT NULL UNIQUE,
  expira_em             timestamptz NOT NULL,
  consumido_em          timestamptz,
  extern_id_vinculado   varchar(255),
  CONSTRAINT solicitacao_vinculo_expiracao_check CHECK (expira_em > created_at)
);
CREATE INDEX idx_solicitacao_vinculo_perfil
  ON public.solicitacao_vinculo_identidade (perfil_id, created_at DESC);
CREATE INDEX idx_solicitacao_vinculo_pendente
  ON public.solicitacao_vinculo_identidade (canal, expira_em)
  WHERE consumido_em IS NULL;

-- Limitação por remetente que a Evolution API/n8n já confirmou. Fica separada
-- do código porque uma tentativa incorreta não identifica uma solicitação.
CREATE TABLE public.limite_vinculo_canal (
  canal                varchar(20) NOT NULL CHECK (canal IN ('whatsapp', 'telegram')),
  extern_id            varchar(255) NOT NULL,
  janela_iniciada_em   timestamptz NOT NULL DEFAULT now(),
  tentativas           smallint NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  ultima_tentativa_em  timestamptz,
  bloqueado_ate        timestamptz,
  PRIMARY KEY (canal, extern_id)
);
CREATE INDEX idx_limite_vinculo_bloqueado
  ON public.limite_vinculo_canal (bloqueado_ate)
  WHERE bloqueado_ate IS NOT NULL;

-- =============================================================================
-- IA COPILOTO — AUTENTICAÇÃO E LICENCIAMENTO PARA IAs EXTERNAS
-- =============================================================================
CREATE TABLE public.ia_copiloto (
  id                       uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  nome                     varchar(100) NOT NULL,
  descricao                text,
  api_key_hash             varchar(64) NOT NULL UNIQUE, -- SHA-256 da chave API
  api_key_prefix           varchar(8) NOT NULL,         -- Primeiros 8 chars para identificação
  ativo                    boolean NOT NULL DEFAULT true,
  revogado_em              timestamptz,
  revogado_por             uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  escopos                  text[] NOT NULL DEFAULT '{ler_necessidades,criar_necessidades,ler_solutions}'::text[],
  requisicoes_por_minuto   integer NOT NULL DEFAULT 60 CHECK (requisicoes_por_minuto > 0),
  requisicoes_hoje         integer NOT NULL DEFAULT 0 CHECK (requisicoes_hoje >= 0),
  ultima_requisicao_em     timestamptz,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT ia_copiloto_escopos_check CHECK (
    escopos <@ ARRAY['ler_necessidades','criar_necessidades','ler_solutions',
                      'criar_contratacoes','ler_contratacoes','admin']
  )
);
CREATE INDEX idx_ia_copiloto_api_key_prefix
  ON public.ia_copiloto (api_key_prefix) WHERE ativo = true;
CREATE INDEX idx_ia_copiloto_ativo
  ON public.ia_copiloto (ativo) WHERE ativo = true;
CREATE TRIGGER trg_ia_copiloto_updated_at
  BEFORE UPDATE ON public.ia_copiloto
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Auditoria de chamadas de API das IAs copiloto. Usado para rate limiting e troubleshooting.
CREATE TABLE public.ia_copiloto_log (
  id              uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  ia_copiloto_id  uuid NOT NULL REFERENCES public.ia_copiloto(id) ON DELETE CASCADE,
  endpoint        varchar(100) NOT NULL,
  metodo          varchar(10) NOT NULL CHECK (metodo IN ('GET','POST','PUT','DELETE')),
  status_code     smallint,
  duracao_ms      integer,
  ip_origem       inet,
  user_agent      text,
  necessidade_id  uuid,
  solution_id     uuid,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_ia_copiloto_log_ia_created
  ON public.ia_copiloto_log (ia_copiloto_id, created_at DESC);
CREATE INDEX idx_ia_copiloto_log_necessidade
  ON public.ia_copiloto_log (necessidade_id) WHERE necessidade_id IS NOT NULL;
CREATE INDEX idx_ia_copiloto_log_solution
  ON public.ia_copiloto_log (solution_id) WHERE solution_id IS NOT NULL;

-- =============================================================================
-- LOCALIDADES E ENDEREÇOS
-- =============================================================================
CREATE TABLE public.localidade (
  id             uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  parent_id      uuid REFERENCES public.localidade(id) ON DELETE RESTRICT,
  tipo           varchar(20) NOT NULL CHECK (tipo IN (
    'pais', 'estado', 'distrito_federal', 'municipio',
    'regiao_administrativa', 'bairro'
  )),
  nome           varchar(100) NOT NULL,
  slug           varchar(120) NOT NULL,
  uf             varchar(2),
  codigo_ibge    varchar(12),
  centro         geography(Point, 4326),
  limite         geography(MultiPolygon, 4326),
  populacao      integer CHECK (populacao IS NULL OR populacao >= 0),
  ativo          boolean NOT NULL DEFAULT true,
  CONSTRAINT localidade_slug_check CHECK (public.slug_valido(slug))
);
CREATE UNIQUE INDEX uq_localidade_parent_slug
  ON public.localidade (parent_id, slug) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX uq_localidade_raiz_slug
  ON public.localidade (slug) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX uq_localidade_codigo_ibge
  ON public.localidade (codigo_ibge) WHERE codigo_ibge IS NOT NULL;
CREATE INDEX idx_localidade_parent ON public.localidade (parent_id);
CREATE INDEX idx_localidade_nome_trgm ON public.localidade USING GIN (nome gin_trgm_ops);
CREATE INDEX idx_localidade_centro ON public.localidade USING GIST (centro);
CREATE INDEX idx_localidade_limite ON public.localidade USING GIST (limite);
CREATE TRIGGER trg_localidade_updated_at
  BEFORE UPDATE ON public.localidade
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Camada de descoberta/SEO, desacoplada do cadastro de habilidade. Ninguém
-- cadastra item "contra" essa tabela — ela existe só pra dar nome a uma
-- página. Termos nascem semeados manualmente (origem='manual', os óbvios:
-- eletricista, encanador...) ou detectados depois por evidência real de
-- busca sem página correspondente (origem='busca_detectada', via job).
-- O matching de quem aparece na página é por similaridade de embedding
-- contra item.embedding, no momento da geração/recálculo da página — não
-- existe FK entre termo_busca e item.
CREATE TABLE public.termo_busca (
  id            uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  termo         varchar(120) NOT NULL,
  slug          varchar(140) NOT NULL UNIQUE,
  embedding     vector(1536),
  origem        varchar(20) NOT NULL DEFAULT 'manual'
                CHECK (origem IN ('manual', 'busca_detectada')),
  ativo         boolean NOT NULL DEFAULT true,
  CONSTRAINT termo_busca_slug_check CHECK (public.slug_valido(slug))
);
CREATE INDEX idx_termo_busca_embedding ON public.termo_busca
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE TRIGGER trg_termo_busca_updated_at
  BEFORE UPDATE ON public.termo_busca
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.endereco (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  user_perfil_id   uuid REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  localidade_id    uuid REFERENCES public.localidade(id) ON DELETE RESTRICT,
  nome             varchar(40),
  localizacao      geography(Point, 4326),
  cep              varchar(8),
  cidade           varchar(100),
  estado           varchar(2),
  pais             varchar(50) NOT NULL DEFAULT 'Brasil',
  logradouro       varchar(150),
  numero           varchar(20),
  bairro           varchar(100),
  complemento      varchar(100),
  descricao        varchar(255),
  publico          boolean NOT NULL DEFAULT false,
  CONSTRAINT endereco_cep_check CHECK (cep IS NULL OR cep ~ '^[0-9]{8}$')
);
CREATE INDEX idx_endereco_user ON public.endereco (user_perfil_id);
CREATE INDEX idx_endereco_localidade ON public.endereco (localidade_id);
CREATE INDEX idx_endereco_geo ON public.endereco USING GIST (localizacao);
CREATE TRIGGER trg_endereco_updated_at
  BEFORE UPDATE ON public.endereco
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =============================================================================
-- LOJAS E PROFISSIONAIS
-- =============================================================================
CREATE SEQUENCE public.profissional_codigo_seq START 1000;

CREATE TABLE public.loja (
  id                    uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  dono_id               uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  endereco_id           uuid REFERENCES public.endereco(id) ON DELETE SET NULL,
  nome                  varchar(120) NOT NULL,
  slug                  varchar(140) NOT NULL,
  descricao             text,
  cnpj                  varchar(14),
  telefone              varchar(20),
  email                 varchar(255),
  localizacao           geography(Point, 4326),
  horarios              jsonb,
  pix_chave_recebimento varchar(255),
  status                public.status_publicacao_enum NOT NULL DEFAULT 'rascunho',
  verificacao           public.status_verificacao_enum NOT NULL DEFAULT 'nao_iniciada',
  aberto                boolean NOT NULL DEFAULT false,
  website_url           text,
  platform_url          text,
  aceita_orcamento      boolean NOT NULL DEFAULT false,
  CONSTRAINT loja_slug_check CHECK (public.slug_valido(slug)),
  CONSTRAINT loja_slug_unique UNIQUE (slug),
  CONSTRAINT loja_cnpj_check CHECK (cnpj IS NULL OR cnpj ~ '^[0-9]{14}$')
);
CREATE UNIQUE INDEX uq_loja_cnpj ON public.loja (cnpj) WHERE cnpj IS NOT NULL;
CREATE INDEX idx_loja_dono ON public.loja (dono_id);
CREATE INDEX idx_loja_endereco ON public.loja (endereco_id);
CREATE INDEX idx_loja_geo ON public.loja USING GIST (localizacao);
CREATE INDEX idx_loja_nome_trgm ON public.loja USING GIN (nome gin_trgm_ops);
CREATE TRIGGER trg_loja_updated_at
  BEFORE UPDATE ON public.loja
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- profissional_perfil deixou de ser uma entidade separada: qualquer user_perfil
-- pode anunciar habilidades preenchendo estes campos. Sem tabela/gate à parte,
-- sem "virar profissional" — só publicar. As colunas são adicionadas aqui via
-- ALTER (não no CREATE TABLE original, lá em cima) porque dependem de
-- public.endereco, dos enums de status e da sequence abaixo, que só existem
-- a partir deste ponto do arquivo.
-- profissional_codigo_seq já existe (linha ~355).
ALTER TABLE public.user_perfil
  ADD COLUMN codigo_publico         varchar(30) UNIQUE
                                     DEFAULT ('pr_' || nextval('public.profissional_codigo_seq')),
  ADD COLUMN endereco_id            uuid REFERENCES public.endereco(id) ON DELETE SET NULL,
  ADD COLUMN nome_publico           varchar(120),
  ADD COLUMN slug                   varchar(150),
  ADD COLUMN titulo                 varchar(160),
  -- Dimensão separada de item/habilidade: a pessoa pode se descrever com
  -- uma ou mais profissões livres ("arquiteta de interiores", "level designer")
  -- sem que isso vire taxonomia nem gate de cadastro — mesmo espírito do
  -- habilidade-livre em item, só que no nível da identidade da pessoa, não
  -- da oferta específica. Alimenta busca/embedding junto com item, dando
  -- o sinal duplo (profissão da pessoa + habilidade de cada oferta).
  ADD COLUMN profissoes             text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN bio                    text,
  ADD COLUMN telefone_publico       varchar(20),
  ADD COLUMN email_publico          varchar(255),
  ADD COLUMN website_url            text,
  ADD COLUMN platform_url           text,
  ADD COLUMN provider_action_url    text,
  ADD COLUMN localizacao            geography(Point, 4326),
  ADD COLUMN atende_emergencia      boolean NOT NULL DEFAULT false,
  ADD COLUMN aceita_orcamento       boolean NOT NULL DEFAULT true,
  ADD COLUMN status                 public.status_publicacao_enum NOT NULL DEFAULT 'rascunho',
  ADD COLUMN verificacao_identidade public.status_verificacao_enum NOT NULL DEFAULT 'nao_iniciada',
  ADD COLUMN verificacao_contato    public.status_verificacao_enum NOT NULL DEFAULT 'nao_iniciada',
  ADD COLUMN verificacao_endereco   public.status_verificacao_enum NOT NULL DEFAULT 'nao_iniciada',
  ADD COLUMN verificado_em          timestamptz,
  ADD COLUMN indice_confianca       numeric(5,2) NOT NULL DEFAULT 0
                                     CHECK (indice_confianca >= 0 AND indice_confianca <= 100),
  ADD COLUMN jobs_concluidos        integer NOT NULL DEFAULT 0 CHECK (jobs_concluidos >= 0),
  ADD COLUMN ultima_atividade_em    timestamptz,
  ADD CONSTRAINT user_perfil_slug_check CHECK (slug IS NULL OR public.slug_valido(slug)),
  ADD CONSTRAINT user_perfil_slug_unique UNIQUE (slug),
  ADD CONSTRAINT user_perfil_platform_url_check CHECK (
    platform_url IS NULL OR platform_url ~ '^https?://'
  ),
  ADD CONSTRAINT user_perfil_action_url_check CHECK (
    provider_action_url IS NULL OR provider_action_url ~ '^https?://'
  ),
  -- Preserva a regra antiga: só pode publicar quem preencheu nome e slug
  -- públicos. Antes isso era garantido pelo NOT NULL da tabela separada;
  -- agora vira condicional, porque a maioria das contas nunca publica.
  ADD CONSTRAINT user_perfil_publicado_requer_dados_check CHECK (
    status <> 'publicado' OR (nome_publico IS NOT NULL AND slug IS NOT NULL)
  );
-- avatar_url já existe em user_perfil (linha ~141) — reaproveitado tanto pro
-- avatar pessoal quanto pro público, não duplicado.
CREATE INDEX idx_user_perfil_endereco ON public.user_perfil (endereco_id);
CREATE INDEX idx_user_perfil_geo ON public.user_perfil USING GIST (localizacao);
CREATE INDEX idx_user_perfil_nome_publico_trgm
  ON public.user_perfil USING GIN (nome_publico gin_trgm_ops);
CREATE INDEX idx_user_perfil_profissoes
  ON public.user_perfil USING GIN (profissoes);
CREATE INDEX idx_user_perfil_publicado
  ON public.user_perfil (status, ultima_atividade_em DESC)
  WHERE status = 'publicado';
-- Sem trigger de updated_at nova: trg_user_perfil_updated_at (linha ~152)
-- já cobre a linha inteira, essas colunas inclusas.

CREATE TABLE public.area_atendimento (
  id                  uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id     uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  localidade_id       uuid REFERENCES public.localidade(id) ON DELETE CASCADE,
  centro              geography(Point, 4326),
  raio_km             numeric(7,2) CHECK (raio_km IS NULL OR raio_km > 0),
  poligono            geography(MultiPolygon, 4326),
  prioridade          smallint NOT NULL DEFAULT 0,
  taxa_deslocamento   numeric(10,2) CHECK (taxa_deslocamento IS NULL OR taxa_deslocamento >= 0),
  ativo               boolean NOT NULL DEFAULT true,
  CONSTRAINT area_atendimento_definida_check CHECK (
    num_nonnulls(localidade_id, centro, poligono) >= 1
  )
);
CREATE INDEX idx_area_profissional ON public.area_atendimento (profissional_id, ativo);
CREATE INDEX idx_area_localidade ON public.area_atendimento (localidade_id, ativo);
CREATE INDEX idx_area_centro ON public.area_atendimento USING GIST (centro);
CREATE INDEX idx_area_poligono ON public.area_atendimento USING GIST (poligono);

CREATE TABLE public.credencial_profissional (
  id                 uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id    uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  tipo               varchar(40) NOT NULL,
  nome               varchar(160) NOT NULL,
  emissor            varchar(160),
  numero_mascarado   varchar(80),
  emitido_em         date,
  expira_em          date,
  status             public.status_verificacao_enum NOT NULL DEFAULT 'pendente',
  verificado_em      timestamptz,
  documento_path     text,
  documento_nome     text,
  documento_mime     text,
  documento_tamanho  bigint,
  publica            boolean NOT NULL DEFAULT true,
  metadados          jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_credencial_profissional
  ON public.credencial_profissional (profissional_id, status);
CREATE UNIQUE INDEX uq_credencial_profissional_documento_path
  ON public.credencial_profissional (documento_path)
  WHERE documento_path IS NOT NULL;
CREATE TRIGGER trg_credencial_profissional_updated_at
  BEFORE UPDATE ON public.credencial_profissional
  FOR EACH ROW EXECUTE FUNCTION public.atualizar_timestamp_acervo_prestador();

CREATE TABLE public.apolice_seguro (
  id                uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id   uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  seguradora        varchar(160) NOT NULL,
  tipo_cobertura    varchar(120) NOT NULL,
  numero_mascarado  varchar(80),
  inicio_em         date NOT NULL,
  fim_em            date NOT NULL,
  valor_cobertura   numeric(14,2) CHECK (valor_cobertura IS NULL OR valor_cobertura >= 0),
  status            public.status_verificacao_enum NOT NULL DEFAULT 'pendente',
  CONSTRAINT apolice_periodo_check CHECK (fim_em >= inicio_em)
);
CREATE INDEX idx_apolice_profissional_vigencia
  ON public.apolice_seguro (profissional_id, fim_em DESC, status);

CREATE TABLE public.midia_profissional (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id  uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  tipo             varchar(20) NOT NULL CHECK (tipo IN ('imagem', 'video', 'documento')),
  url              text NOT NULL,
  storage_path     text,
  mime_type        text,
  tamanho_bytes    bigint,
  legenda          varchar(300),
  ordem            integer NOT NULL DEFAULT 0,
  verificada       boolean NOT NULL DEFAULT false,
  publica          boolean NOT NULL DEFAULT true,
  capa             boolean NOT NULL DEFAULT false
);
CREATE INDEX idx_midia_profissional
  ON public.midia_profissional (profissional_id, publica, ordem);
CREATE UNIQUE INDEX uq_midia_profissional_storage_path
  ON public.midia_profissional (storage_path)
  WHERE storage_path IS NOT NULL;
CREATE UNIQUE INDEX uq_midia_profissional_capa
  ON public.midia_profissional (profissional_id)
  WHERE capa = true;
CREATE TRIGGER trg_midia_profissional_updated_at
  BEFORE UPDATE ON public.midia_profissional
  FOR EACH ROW EXECUTE FUNCTION public.atualizar_timestamp_acervo_prestador();

CREATE TABLE public.disponibilidade_semanal (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id  uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  dia_semana       smallint NOT NULL CHECK (dia_semana BETWEEN 0 AND 6),
  inicio           time NOT NULL,
  fim              time NOT NULL,
  timezone         varchar(50) NOT NULL DEFAULT 'America/Sao_Paulo',
  ativo            boolean NOT NULL DEFAULT true,
  CONSTRAINT disponibilidade_horario_check CHECK (fim > inicio),
  CONSTRAINT disponibilidade_unique UNIQUE (profissional_id, dia_semana, inicio, fim)
);

CREATE TABLE public.bloqueio_agenda (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  profissional_id  uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  periodo          tstzrange NOT NULL,
  motivo           varchar(200),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bloqueio_periodo_check CHECK (NOT isempty(periodo))
);
CREATE INDEX idx_bloqueio_profissional ON public.bloqueio_agenda (profissional_id);
CREATE INDEX idx_bloqueio_periodo ON public.bloqueio_agenda USING GIST (periodo);

-- =============================================================================
-- OFERTAS: PRODUTOS, ITENS VIRTUAIS E SERVIÇOS CONTRATÁVEIS
-- =============================================================================
CREATE TABLE public.item (
  id                   uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  nome                 varchar(160) NOT NULL,
  slug                 varchar(180) NOT NULL,
  descricao            text,
  tipo_oferta          public.tipo_oferta_enum NOT NULL,
  loja_id              uuid REFERENCES public.loja(id) ON DELETE CASCADE,
  profissional_id      uuid REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  categoria_produto    varchar(100),
  localizacao          geography(Point, 4326),
  tipo_preco           public.tipo_preco_enum NOT NULL DEFAULT 'fixo',
  preco_min            numeric(12,2) CHECK (preco_min IS NULL OR preco_min >= 0),
  preco_max            numeric(12,2) CHECK (preco_max IS NULL OR preco_max >= 0),
  nome_metrica         public.nome_metrica_enum,
  valor_metrica        numeric(12,2) CHECK (valor_metrica IS NULL OR valor_metrica >= 0),
  metrica_min          numeric(12,2) CHECK (metrica_min IS NULL OR metrica_min >= 0),
  estoque              numeric(14,3) CHECK (estoque IS NULL OR estoque >= 0),
  replicas             integer NOT NULL DEFAULT 1 CHECK (replicas > 0),
  midia                jsonb NOT NULL DEFAULT '[]'::jsonb,
  contatos             jsonb,
  disponivel           boolean NOT NULL DEFAULT true,
  status               public.status_publicacao_enum NOT NULL DEFAULT 'rascunho',
  quantidade_pedidos   integer NOT NULL DEFAULT 0 CHECK (quantidade_pedidos >= 0),
  search_vector        tsvector GENERATED ALWAYS AS (
    to_tsvector(
      'portuguese',
      coalesce(nome, '') || ' ' || coalesce(descricao, '') || ' ' ||
      coalesce(categoria_produto, '')
    )
  ) STORED,
  -- Cópia secundária do embedding dense — truncada pra 1536 dim (não os
  -- 3072 completos do text-embedding-3-large). pgvector não indexa (HNSW
  -- nem IVFFlat) acima de 2000 dimensões, e o modelo é treinado pra suportar
  -- truncamento + renormalização sem perder muita qualidade semântica —
  -- não precisa de segunda chamada à OpenAI, só corta e renormaliza o
  -- vetor que já foi gerado pro Qdrant. Qdrant guarda o vetor completo
  -- (3072) e continua sendo o motor principal (faz fusão híbrida
  -- dense+sparse); essa coluna existe pra busca combinada com filtro
  -- relacional direto em SQL e como plano B se o Qdrant estiver fora do
  -- ar. Preenchida pelo mesmo pipeline que grava no Qdrant, não por
  -- escrita direta do cliente.
  embedding            vector(1536),
  CONSTRAINT item_slug_check CHECK (public.slug_valido(slug)),
  CONSTRAINT item_responsavel_check CHECK (num_nonnulls(loja_id, profissional_id) = 1),
  CONSTRAINT item_servico_profissional_check CHECK (
    tipo_oferta NOT IN ('habilidade', 'servico') OR profissional_id IS NOT NULL
  ),
  CONSTRAINT item_preco_faixa_check CHECK (
    preco_max IS NULL OR preco_min IS NULL OR preco_max >= preco_min
  ),
  CONSTRAINT item_preco_metrica_check CHECK (
    tipo_preco <> 'por_metrica' OR
    (nome_metrica IS NOT NULL AND valor_metrica IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_item_loja_slug
  ON public.item (loja_id, slug) WHERE loja_id IS NOT NULL;
CREATE UNIQUE INDEX uq_item_profissional_slug
  ON public.item (profissional_id, slug) WHERE profissional_id IS NOT NULL;
CREATE INDEX idx_item_loja ON public.item (loja_id);
CREATE INDEX idx_item_profissional ON public.item (profissional_id);
CREATE INDEX idx_item_geo ON public.item USING GIST (localizacao);
CREATE INDEX idx_item_search ON public.item USING GIN (search_vector);
CREATE INDEX idx_item_nome_trgm ON public.item USING GIN (nome gin_trgm_ops);
-- HNSW com cosseno — padrão pra embeddings da OpenAI. Índice parcial:
-- só cobre linhas que já têm embedding calculado, não perde tempo/espaço
-- com item recém-criado que ainda não passou pelo pipeline de indexação.
CREATE INDEX idx_item_embedding ON public.item
  USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE TRIGGER trg_item_updated_at
  BEFORE UPDATE ON public.item
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- midia_profissional é criada antes de item existir; a coluna que a liga
-- à habilidade específica só pode ser adicionada aqui, depois que item já existe.
ALTER TABLE public.midia_profissional
  ADD COLUMN item_id uuid REFERENCES public.item(id) ON DELETE SET NULL;

-- View de leitura: dá o nome "habilidade" pra quem consulta, batendo com o
-- vocabulário do produto e com a collection do Qdrant, sem duplicar
-- armazenamento — o dado continua vivendo só em item.
CREATE VIEW public.habilidade AS
  SELECT * FROM public.item WHERE tipo_oferta = 'habilidade';

-- =============================================================================
-- FAVORITOS E VISTOS RECENTEMENTE
-- =============================================================================
CREATE TABLE public.favorito (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  user_perfil_id   uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  item_id          uuid REFERENCES public.item(id) ON DELETE CASCADE,
  profissional_id  uuid REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  loja_id          uuid REFERENCES public.loja(id) ON DELETE CASCADE,
  CONSTRAINT favorito_alvo_check CHECK (num_nonnulls(item_id, profissional_id, loja_id) = 1)
);
CREATE UNIQUE INDEX uq_favorito_item
  ON public.favorito (user_perfil_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_favorito_profissional
  ON public.favorito (user_perfil_id, profissional_id) WHERE profissional_id IS NOT NULL;
CREATE UNIQUE INDEX uq_favorito_loja
  ON public.favorito (user_perfil_id, loja_id) WHERE loja_id IS NOT NULL;
CREATE INDEX idx_favorito_usuario_recente
  ON public.favorito (user_perfil_id, created_at DESC);
CREATE INDEX idx_favorito_item_contagem ON public.favorito (item_id) WHERE item_id IS NOT NULL;
CREATE INDEX idx_favorito_profissional_contagem
  ON public.favorito (profissional_id) WHERE profissional_id IS NOT NULL;

CREATE TABLE public.visualizacao_recente (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  user_perfil_id   uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  item_id          uuid REFERENCES public.item(id) ON DELETE CASCADE,
  profissional_id  uuid REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  loja_id          uuid REFERENCES public.loja(id) ON DELETE CASCADE,
  primeira_visita  timestamptz NOT NULL DEFAULT now(),
  visto_em         timestamptz NOT NULL DEFAULT now(),
  total_visitas    integer NOT NULL DEFAULT 1 CHECK (total_visitas > 0),
  CONSTRAINT visualizacao_alvo_check CHECK (num_nonnulls(item_id, profissional_id, loja_id) = 1)
);
CREATE UNIQUE INDEX uq_visualizacao_item
  ON public.visualizacao_recente (user_perfil_id, item_id) WHERE item_id IS NOT NULL;
CREATE UNIQUE INDEX uq_visualizacao_profissional
  ON public.visualizacao_recente (user_perfil_id, profissional_id)
  WHERE profissional_id IS NOT NULL;
CREATE UNIQUE INDEX uq_visualizacao_loja
  ON public.visualizacao_recente (user_perfil_id, loja_id) WHERE loja_id IS NOT NULL;
CREATE INDEX idx_visualizacao_usuario_recente
  ON public.visualizacao_recente (user_perfil_id, visto_em DESC);

-- =============================================================================
-- NECESSIDADES, SOLUÇÕES, COMANDAS, PAGAMENTOS E REPASSES
-- =============================================================================

-- NECESSIDADE: relato do problema tal como o usuário descreveu; fonte de verdade.
-- Mantém jsonb para composicao/midias (variáveis e aninhadas) e colunas
-- tipadas para os campos que o frontend/IA sempre filtra ou ordena.
CREATE TABLE public.necessidade (
  id                          uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  expira_em                   timestamptz NOT NULL,
  user_id                     uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  ia_copiloto_id              uuid REFERENCES public.ia_copiloto(id) ON DELETE SET NULL,
  -- Identificação do canal que originou a necessidade
  canal_origem                varchar(50),
  idioma                      varchar(10) NOT NULL DEFAULT 'pt-BR',
  moeda                       char(3) NOT NULL DEFAULT 'BRL',
  urgencia                    public.urgencia_enum NOT NULL DEFAULT 'media',
  -- Texto do problema (fonte de verdade)
  descricao_necessidade       text NOT NULL,
  mensagem_origem             text, -- mensagem original do usuário, preservada para auditoria
  resumo                      varchar(300), -- descrição curta gerada pela IA
  -- Localização: texto livre + vínculo com taxonomia oficial
  cidade                      varchar(100),
  bairro                      varchar(100),
  localidade_id               uuid REFERENCES public.localidade(id) ON DELETE SET NULL,
  localizacao                 geography(Point, 4326),
  -- Prazos
  prazo_inicio                timestamptz,
  prazo_conclusao             timestamptz,
  -- Flags de comportamento
  requer_vistoria             boolean NOT NULL DEFAULT false,
  privado                     boolean NOT NULL DEFAULT false,
  -- Conteúdo variável: composicao (servicos/produtos/habilidades) e midias
  composicao                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  midias                      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Resultado/soluções geradas (cache da última versão pronta)
  resultado                   jsonb,
  -- Token de compartilhamento (hash SHA-256) para link público
  token_compartilhamento_hash varchar(64) UNIQUE,
  -- Status e vínculo com comanda
  visto_em                    timestamptz,
  status                      varchar(20) NOT NULL DEFAULT 'pendente'
                              CHECK (status IN (
                                'pendente', 'em_interpretacao', 'em_composicao',
                                'solutions_prontas', 'expirado', 'convertido', 'cancelado'
                              )),
  comanda_id                  uuid,
  CONSTRAINT necessidade_prazo_check CHECK (
    prazo_conclusao IS NULL OR prazo_inicio IS NULL OR prazo_conclusao >= prazo_inicio
  )
);
CREATE INDEX idx_necessidade_user ON public.necessidade (user_id, created_at DESC);
CREATE INDEX idx_necessidade_ia ON public.necessidade (ia_copiloto_id, created_at DESC);
CREATE INDEX idx_necessidade_localidade ON public.necessidade (localidade_id);
CREATE INDEX idx_necessidade_geo ON public.necessidade USING GIST (localizacao);
CREATE INDEX idx_necessidade_status ON public.necessidade (status, created_at DESC);
CREATE INDEX idx_necessidade_urgencia ON public.necessidade (urgencia);
CREATE INDEX idx_necessidade_canal ON public.necessidade (canal_origem);
CREATE INDEX idx_necessidade_token ON public.necessidade (token_compartilhamento_hash)
  WHERE token_compartilhamento_hash IS NOT NULL;
CREATE TRIGGER trg_necessidade_updated_at
  BEFORE UPDATE ON public.necessidade
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- SOLUTION: uma proposta concreta gerada para uma necessidade.
-- Campos de apresentação (valor, prazo, posicao) ficam tipados para facilitar
-- consultas; o detalhe completo (composicao, adicionais, prestadores) fica em conteudo.
CREATE TABLE public.solution (
  id                           uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  necessidade_id               uuid NOT NULL REFERENCES public.necessidade(id) ON DELETE CASCADE,
  perfil_id                    uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  identidade_origem_id         uuid REFERENCES public.user_identidade(id) ON DELETE SET NULL,
  canal_origem                 varchar(20) NOT NULL,
  contato_origem_normalizado   varchar(255),
  -- Apresentação
  posicao                      integer NOT NULL DEFAULT 0,
  resumo                       varchar(300),
  valor_total                  numeric(14,2) CHECK (valor_total IS NULL OR valor_total >= 0),
  moeda                        char(3) NOT NULL DEFAULT 'BRL',
  prazo_inicio                 timestamptz,
  prazo_conclusao              timestamptz,
  requer_vistoria              boolean NOT NULL DEFAULT false,
  expira_em                    timestamptz,
  -- Conteúdo detalhado (composicao, adicionais, prestadores_disponiveis, meta)
  conteudo                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  versao                       integer NOT NULL DEFAULT 1 CHECK (versao > 0),
  status                       varchar(20) NOT NULL DEFAULT 'processando'
                               CHECK (status IN (
                                 'processando', 'pronto', 'visualizado',
                                 'expirado', 'arquivado'
                               )),
  pronto_em                    timestamptz,
  visualizado_em               timestamptz
);
CREATE INDEX idx_solution_necessidade ON public.solution (necessidade_id, posicao);
CREATE INDEX idx_solution_perfil ON public.solution (perfil_id, created_at DESC);
CREATE INDEX idx_solution_status ON public.solution (status, pronto_em DESC);
CREATE INDEX idx_solution_expira ON public.solution (expira_em)
  WHERE status = 'pronto';
CREATE TRIGGER trg_solution_updated_at
  BEFORE UPDATE ON public.solution
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Link de compartilhamento de solution. A URL carrega o token bruto uma única vez;
-- o banco guarda somente SHA-256. O telefone da URL nunca é usado como prova.
CREATE TABLE public.solution_acesso (
  id                       uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at               timestamptz NOT NULL DEFAULT now(),
  solution_id              uuid NOT NULL REFERENCES public.solution(id) ON DELETE CASCADE,
  token_hash               varchar(64) NOT NULL UNIQUE,
  expira_em                timestamptz NOT NULL,
  consumido_em             timestamptz,
  consumido_por_auth_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revogado_em              timestamptz,
  CONSTRAINT solution_acesso_expiracao_check CHECK (expira_em > created_at)
);
CREATE INDEX idx_solution_acesso_solution ON public.solution_acesso (solution_id, created_at DESC);
CREATE INDEX idx_solution_acesso_pendente ON public.solution_acesso (expira_em)
  WHERE consumido_em IS NULL AND revogado_em IS NULL;

CREATE TABLE public.comanda (
  id             uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  cliente_id     uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  endereco_id    uuid REFERENCES public.endereco(id) ON DELETE SET NULL,
  itens          jsonb NOT NULL DEFAULT '[]'::jsonb,
  status         varchar(30) NOT NULL DEFAULT 'rascunho'
                 CHECK (status IN (
                   'rascunho', 'aguardando_pagamento', 'aberta', 'aceita',
                   'em_andamento', 'aguardando_aceite', 'concluida',
                   'cancelada', 'em_disputa'
                 )),
  valor_total    numeric(14,2) CHECK (valor_total IS NULL OR valor_total >= 0),
  observacoes    text,
  iniciada_em    timestamptz,
  concluida_em   timestamptz,
  aceita_em      timestamptz
);
CREATE INDEX idx_comanda_cliente ON public.comanda (cliente_id, created_at DESC);
CREATE INDEX idx_comanda_status ON public.comanda (status, updated_at DESC);
CREATE TRIGGER trg_comanda_updated_at
  BEFORE UPDATE ON public.comanda
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.necessidade
  ADD CONSTRAINT necessidade_comanda_fkey
  FOREIGN KEY (comanda_id) REFERENCES public.comanda(id) ON DELETE SET NULL;
CREATE INDEX idx_necessidade_comanda ON public.necessidade (comanda_id);

CREATE TABLE public.participante_comanda (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  comanda_id       uuid NOT NULL REFERENCES public.comanda(id) ON DELETE CASCADE,
  profissional_id  uuid REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  loja_id          uuid REFERENCES public.loja(id) ON DELETE RESTRICT,
  papel            varchar(30) NOT NULL CHECK (papel IN (
    'prestador', 'loja', 'entregador', 'seguradora', 'plataforma'
  )),
  valor_previsto   numeric(14,2) NOT NULL DEFAULT 0 CHECK (valor_previsto >= 0),
  status           varchar(20) NOT NULL DEFAULT 'convidado'
                   CHECK (status IN ('convidado', 'aceito', 'recusado', 'executando', 'concluido', 'cancelado')),
  CONSTRAINT participante_destino_check CHECK (
    (papel IN ('prestador', 'entregador') AND profissional_id IS NOT NULL AND loja_id IS NULL)
    OR (papel = 'loja' AND loja_id IS NOT NULL AND profissional_id IS NULL)
    OR (papel IN ('seguradora', 'plataforma') AND profissional_id IS NULL AND loja_id IS NULL)
  )
);
CREATE INDEX idx_participante_comanda ON public.participante_comanda (comanda_id);
CREATE INDEX idx_participante_profissional
  ON public.participante_comanda (profissional_id) WHERE profissional_id IS NOT NULL;

CREATE TABLE public.pagamento (
  id                      uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  comanda_id              uuid NOT NULL REFERENCES public.comanda(id) ON DELETE RESTRICT,
  metodo                  varchar(30) NOT NULL CHECK (metodo IN (
    'pix', 'cartao_credito', 'cartao_debito', 'boleto',
    'carteira', 'voucher', 'dinheiro'
  )),
  status                  varchar(25) NOT NULL DEFAULT 'pendente' CHECK (status IN (
    'pendente', 'processando', 'pago', 'falhou',
    'cancelado', 'estornado', 'parcialmente_estornado'
  )),
  valor                   numeric(14,2) NOT NULL CHECK (valor > 0),
  moeda                   char(3) NOT NULL DEFAULT 'BRL',
  gateway                 varchar(50),
  gateway_pagamento_id    varchar(255),
  pago_em                 timestamptz,
  metadados               jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX uq_pagamento_gateway_id
  ON public.pagamento (gateway, gateway_pagamento_id)
  WHERE gateway_pagamento_id IS NOT NULL;
CREATE INDEX idx_pagamento_comanda ON public.pagamento (comanda_id, created_at DESC);
CREATE INDEX idx_pagamento_status ON public.pagamento (status, created_at DESC);
CREATE TRIGGER trg_pagamento_updated_at
  BEFORE UPDATE ON public.pagamento
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.divisao_pagamento (
  id                    uuid PRIMARY KEY DEFAULT public.uuidv7(),
  pagamento_id          uuid NOT NULL REFERENCES public.pagamento(id) ON DELETE RESTRICT,
  participante_id       uuid REFERENCES public.participante_comanda(id) ON DELETE RESTRICT,
  papel                 varchar(30) NOT NULL CHECK (papel IN (
    'prestador', 'loja', 'entregador', 'seguradora', 'plataforma'
  )),
  valor                 numeric(14,2) NOT NULL CHECK (valor >= 0),
  status                varchar(20) NOT NULL DEFAULT 'retido'
                        CHECK (status IN ('retido', 'liberado', 'pago', 'cancelado', 'estornado')),
  liberado_em           timestamptz,
  pago_em               timestamptz,
  gateway_transfer_id   varchar(255),
  CONSTRAINT divisao_participante_check CHECK (
    (papel IN ('prestador', 'loja', 'entregador') AND participante_id IS NOT NULL)
    OR (papel IN ('seguradora', 'plataforma'))
  )
);
CREATE INDEX idx_divisao_pagamento ON public.divisao_pagamento (pagamento_id);
CREATE INDEX idx_divisao_participante ON public.divisao_pagamento (participante_id);
CREATE UNIQUE INDEX uq_divisao_gateway_transfer
  ON public.divisao_pagamento (gateway_transfer_id)
  WHERE gateway_transfer_id IS NOT NULL;

-- =============================================================================
-- AVALIAÇÕES — SINAL POSTERIOR, NUNCA REQUISITO DE ENTRADA
-- =============================================================================
CREATE TABLE public.avaliacao (
  id               uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  comanda_id       uuid NOT NULL REFERENCES public.comanda(id) ON DELETE RESTRICT,
  autor_id         uuid NOT NULL REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  profissional_id  uuid REFERENCES public.user_perfil(id) ON DELETE RESTRICT,
  loja_id          uuid REFERENCES public.loja(id) ON DELETE RESTRICT,
  nota             smallint NOT NULL CHECK (nota BETWEEN 1 AND 5),
  titulo           varchar(160),
  comentario       text,
  publica          boolean NOT NULL DEFAULT true,
  verificada       boolean NOT NULL DEFAULT true,
  resposta         text,
  respondida_em    timestamptz,
  CONSTRAINT avaliacao_alvo_check CHECK (num_nonnulls(profissional_id, loja_id) = 1)
);
CREATE UNIQUE INDEX uq_avaliacao_comanda_profissional
  ON public.avaliacao (comanda_id, autor_id, profissional_id)
  WHERE profissional_id IS NOT NULL;
CREATE UNIQUE INDEX uq_avaliacao_comanda_loja
  ON public.avaliacao (comanda_id, autor_id, loja_id)
  WHERE loja_id IS NOT NULL;
CREATE INDEX idx_avaliacao_profissional_publica
  ON public.avaliacao (profissional_id, created_at DESC)
  WHERE profissional_id IS NOT NULL AND publica = true;
CREATE TRIGGER trg_avaliacao_updated_at
  BEFORE UPDATE ON public.avaliacao
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE public.avaliacao IS
  'Avaliação vinculada a contratação real. A ausência de avaliações não impede publicação ou recomendação inicial.';

-- =============================================================================
-- PREÇOS REGIONAIS E PÁGINAS SEO
-- =============================================================================
-- Reancorada em termo_busca (antes era servico_catalogo). Alimentada por
-- job periódico agregando preço de item real que casa com o termo — não
-- é curada manualmente linha a linha.
CREATE TABLE public.preco_termo_regiao (
  id                uuid PRIMARY KEY DEFAULT public.uuidv7(),
  termo_busca_id    uuid NOT NULL REFERENCES public.termo_busca(id) ON DELETE CASCADE,
  localidade_id     uuid NOT NULL REFERENCES public.localidade(id) ON DELETE CASCADE,
  periodo_inicio    date NOT NULL,
  periodo_fim       date NOT NULL,
  preco_min         numeric(12,2) CHECK (preco_min IS NULL OR preco_min >= 0),
  preco_mediano     numeric(12,2) CHECK (preco_mediano IS NULL OR preco_mediano >= 0),
  preco_max         numeric(12,2) CHECK (preco_max IS NULL OR preco_max >= 0),
  tamanho_amostra   integer NOT NULL DEFAULT 0 CHECK (tamanho_amostra >= 0),
  origem            varchar(30) NOT NULL DEFAULT 'itens_publicados'
                    CHECK (origem IN ('itens_publicados', 'orcamentos_reais', 'pesquisa_manual')),
  atualizado_em     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT preco_regiao_periodo_check CHECK (periodo_fim >= periodo_inicio),
  CONSTRAINT preco_regiao_ordem_check CHECK (
    (preco_min IS NULL OR preco_mediano IS NULL OR preco_mediano >= preco_min)
    AND (preco_mediano IS NULL OR preco_max IS NULL OR preco_max >= preco_mediano)
  ),
  CONSTRAINT preco_termo_regiao_unique UNIQUE (termo_busca_id, localidade_id, periodo_inicio, periodo_fim)
);
CREATE INDEX idx_preco_termo_regiao_lookup
  ON public.preco_termo_regiao (termo_busca_id, localidade_id, periodo_fim DESC);

CREATE TABLE public.pagina_seo (
  id                      uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  tipo                    public.tipo_pagina_seo_enum NOT NULL,
  termo_busca_id          uuid REFERENCES public.termo_busca(id) ON DELETE CASCADE,
  localidade_id           uuid REFERENCES public.localidade(id) ON DELETE CASCADE,
  profissional_id         uuid REFERENCES public.user_perfil(id) ON DELETE CASCADE,
  loja_id                 uuid REFERENCES public.loja(id) ON DELETE CASCADE,
  path                    text NOT NULL UNIQUE,
  canonical_url           text NOT NULL UNIQUE,
  title                   varchar(180) NOT NULL,
  meta_description        varchar(320) NOT NULL,
  h1                      varchar(220) NOT NULL,
  resumo                  text,
  conteudo_adicional      jsonb NOT NULL DEFAULT '{}'::jsonb,
  indexavel               boolean NOT NULL DEFAULT false,
  motivo_nao_indexar      varchar(300),
  score_qualidade         numeric(5,2) NOT NULL DEFAULT 0
                          CHECK (score_qualidade >= 0 AND score_qualidade <= 100),
  profissionais_ativos    integer NOT NULL DEFAULT 0 CHECK (profissionais_ativos >= 0),
  disponibilidade_recente boolean NOT NULL DEFAULT false,
  dados_preco_reais       boolean NOT NULL DEFAULT false,
  ultima_validacao_em     timestamptz,
  publicar_no_sitemap     boolean NOT NULL DEFAULT false,
  prioridade_sitemap      numeric(2,1) CHECK (
    prioridade_sitemap IS NULL OR
    (prioridade_sitemap >= 0 AND prioridade_sitemap <= 1)
  ),
  CONSTRAINT pagina_seo_path_check CHECK (path ~ '^/'),
  CONSTRAINT pagina_seo_canonical_check CHECK (canonical_url ~ '^https://'),
  CONSTRAINT pagina_seo_sitemap_check CHECK (
    publicar_no_sitemap = false OR indexavel = true
  ),
  CONSTRAINT pagina_seo_entidade_check CHECK (
    (tipo = 'home' AND num_nonnulls(termo_busca_id, localidade_id, profissional_id, loja_id) = 0)
    OR (tipo = 'servico' AND termo_busca_id IS NOT NULL AND localidade_id IS NULL AND profissional_id IS NULL AND loja_id IS NULL)
    OR (tipo = 'servico_localidade' AND termo_busca_id IS NOT NULL AND localidade_id IS NOT NULL AND profissional_id IS NULL AND loja_id IS NULL)
    OR (tipo = 'profissional' AND profissional_id IS NOT NULL AND termo_busca_id IS NULL AND localidade_id IS NULL AND loja_id IS NULL)
    OR (tipo = 'loja' AND loja_id IS NOT NULL AND termo_busca_id IS NULL AND localidade_id IS NULL AND profissional_id IS NULL)
    OR (tipo = 'conteudo')
  )
);
CREATE UNIQUE INDEX uq_pagina_seo_termo
  ON public.pagina_seo (termo_busca_id)
  WHERE tipo = 'servico';
CREATE UNIQUE INDEX uq_pagina_seo_termo_localidade
  ON public.pagina_seo (termo_busca_id, localidade_id)
  WHERE tipo = 'servico_localidade';
CREATE UNIQUE INDEX uq_pagina_seo_profissional
  ON public.pagina_seo (profissional_id)
  WHERE tipo = 'profissional';
CREATE UNIQUE INDEX uq_pagina_seo_loja
  ON public.pagina_seo (loja_id)
  WHERE tipo = 'loja';
CREATE INDEX idx_pagina_seo_sitemap
  ON public.pagina_seo (updated_at DESC)
  WHERE indexavel = true AND publicar_no_sitemap = true;
CREATE TRIGGER trg_pagina_seo_updated_at
  BEFORE UPDATE ON public.pagina_seo
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.url_redirect (
  id            uuid PRIMARY KEY DEFAULT public.uuidv7(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  origem_path   text NOT NULL UNIQUE,
  destino_url   text NOT NULL,
  status_code   smallint NOT NULL DEFAULT 301 CHECK (status_code IN (301, 302, 307, 308)),
  ativo         boolean NOT NULL DEFAULT true,
  CONSTRAINT url_redirect_origem_check CHECK (origem_path ~ '^/'),
  CONSTRAINT url_redirect_destino_check CHECK (destino_url ~ '^https?://|^/')
);

-- =============================================================================
-- RPCs DE IDENTIDADE E CONTINUIDADE ENTRE CANAIS
-- =============================================================================
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- WhatsApp/Telegram -> n8n -> service_role.
CREATE OR REPLACE FUNCTION public.obter_ou_criar_perfil_canal(
  p_canal text,
  p_extern_id text,
  p_contato_normalizado text DEFAULT NULL,
  p_nome_canal text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL,
  p_locale text DEFAULT 'pt-BR'
) RETURNS TABLE (perfil_id uuid, identidade_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_perfil_id uuid;
  v_identidade_id uuid;
BEGIN
  IF p_canal NOT IN ('whatsapp', 'telegram', 'instagram') THEN
    RAISE EXCEPTION 'canal_interno_invalido';
  END IF;
  IF NULLIF(trim(p_extern_id), '') IS NULL THEN
    RAISE EXCEPTION 'extern_id_obrigatorio';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_canal || ':' || p_extern_id, 0)
  );
  SELECT ui.perfil_id, ui.id
    INTO v_perfil_id, v_identidade_id
  FROM public.user_identidade AS ui
  WHERE ui.canal = p_canal
    AND ui.extern_id = p_extern_id
    AND ui.revogado_em IS NULL
  FOR UPDATE;
  IF v_identidade_id IS NULL THEN
    INSERT INTO public.user_perfil (locale, system_nick_name, system_nick_id)
    VALUES (coalesce(p_locale, 'pt-BR'), p_nome_canal, p_extern_id)
    RETURNING id INTO v_perfil_id;
    INSERT INTO public.user_identidade (
      perfil_id, canal, extern_id, contato_normalizado, nome_canal,
      avatar_url, locale, verificado_em, ultima_utilizacao_em
    ) VALUES (
      v_perfil_id, p_canal, p_extern_id, p_contato_normalizado, p_nome_canal,
      p_avatar_url, p_locale, now(), now()
    ) RETURNING id INTO v_identidade_id;
  ELSE
    UPDATE public.user_identidade
    SET contato_normalizado = coalesce(p_contato_normalizado, contato_normalizado),
        nome_canal = coalesce(p_nome_canal, nome_canal),
        avatar_url = coalesce(p_avatar_url, avatar_url),
        locale = coalesce(p_locale, locale),
        ultima_utilizacao_em = now()
    WHERE id = v_identidade_id;
  END IF;
  RETURN QUERY SELECT v_perfil_id, v_identidade_id;
END;
$$;

-- service_role cria o link enviado ao cliente. Somente o hash é armazenado.
CREATE OR REPLACE FUNCTION public.criar_acesso_solution(
  p_solution_id uuid,
  p_validade_minutos integer DEFAULT 30
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_token text;
BEGIN
  IF p_validade_minutos NOT BETWEEN 1 AND 1440 THEN
    RAISE EXCEPTION 'validade_invalida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.solution WHERE id = p_solution_id) THEN
    RAISE EXCEPTION 'solution_nao_encontrada';
  END IF;
  v_token := encode(gen_random_bytes(32), 'hex');
  INSERT INTO public.solution_acesso (solution_id, token_hash, expira_em)
  VALUES (
    p_solution_id,
    encode(digest(v_token, 'sha256'), 'hex'),
    now() + make_interval(mins => p_validade_minutos)
  );
  RETURN v_token;
END;
$$;

-- Após login Google/Apple/e-mail, o usuário autenticado reivindica a solution.
CREATE OR REPLACE FUNCTION public.reivindicar_solution(p_token text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_acesso_id uuid;
  v_solution_id uuid;
  v_perfil_id uuid;
  v_perfil_auth_user_id uuid;
  v_outro_perfil_id uuid;
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'autenticacao_obrigatoria';
  END IF;
  IF NULLIF(trim(p_token), '') IS NULL THEN
    RAISE EXCEPTION 'token_obrigatorio';
  END IF;
  SELECT oa.id, s.id, s.perfil_id, up.auth_user_id
    INTO v_acesso_id, v_solution_id, v_perfil_id, v_perfil_auth_user_id
  FROM public.solution_acesso AS oa
  JOIN public.solution AS s ON s.id = oa.solution_id
  JOIN public.user_perfil AS up ON up.id = s.perfil_id
  WHERE oa.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    AND oa.revogado_em IS NULL
    AND oa.consumido_em IS NULL
    AND oa.expira_em > now()
  FOR UPDATE OF oa, up;
  IF v_acesso_id IS NULL THEN
    RAISE EXCEPTION 'token_invalido_expirado_ou_consumido';
  END IF;
  SELECT id INTO v_outro_perfil_id
  FROM public.user_perfil
  WHERE auth_user_id = v_auth_user_id
  FOR UPDATE;
  IF v_outro_perfil_id IS NOT NULL AND v_outro_perfil_id <> v_perfil_id THEN
    RAISE EXCEPTION 'auth_ja_vinculado_a_outro_perfil';
  END IF;
  IF v_perfil_auth_user_id IS NOT NULL AND v_perfil_auth_user_id <> v_auth_user_id THEN
    RAISE EXCEPTION 'perfil_ja_vinculado_a_outro_auth';
  END IF;
  UPDATE public.user_perfil
  SET auth_user_id = v_auth_user_id
  WHERE id = v_perfil_id
    AND auth_user_id IS NULL;
  UPDATE public.solution_acesso
  SET consumido_em = now(),
      consumido_por_auth_id = v_auth_user_id
  WHERE id = v_acesso_id;
  UPDATE public.solution
  SET status = CASE WHEN status = 'pronto' THEN 'visualizado' ELSE status END,
      visualizado_em = coalesce(visualizado_em, now())
  WHERE id = v_solution_id;
  RETURN v_solution_id;
END;
$$;

-- Navegador autenticado -> código curto -> mensagem no WhatsApp/Telegram.
CREATE OR REPLACE FUNCTION public.criar_codigo_vinculo_canal(
  p_canal text,
  p_validade_minutos integer DEFAULT 10
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_perfil_id uuid;
  v_codigo text;
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'autenticacao_obrigatoria';
  END IF;
  IF p_canal NOT IN ('whatsapp', 'telegram') THEN
    RAISE EXCEPTION 'canal_invalido';
  END IF;
  IF p_validade_minutos NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'validade_invalida';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('auth:' || v_auth_user_id::text, 0)
  );
  SELECT id INTO v_perfil_id
  FROM public.user_perfil
  WHERE auth_user_id = v_auth_user_id;
  IF v_perfil_id IS NULL THEN
    INSERT INTO public.user_perfil (auth_user_id)
    VALUES (v_auth_user_id)
    RETURNING id INTO v_perfil_id;
  END IF;
  UPDATE public.solicitacao_vinculo_identidade
  SET consumido_em = now()
  WHERE perfil_id = v_perfil_id
    AND canal = p_canal
    AND consumido_em IS NULL;
  v_codigo := upper(substr(encode(gen_random_bytes(8), 'hex'), 1, 10));
  INSERT INTO public.solicitacao_vinculo_identidade (
    perfil_id, auth_user_id, canal, codigo_hash, expira_em
  ) VALUES (
    v_perfil_id,
    v_auth_user_id,
    p_canal,
    encode(digest(v_codigo, 'sha256'), 'hex'),
    now() + make_interval(mins => p_validade_minutos)
  );
  RETURN v_codigo;
END;
$$;

-- WhatsApp/Telegram -> Evolution API -> n8n -> service_role.
CREATE OR REPLACE FUNCTION public.vincular_identidade_por_codigo(
  p_codigo text,
  p_canal text,
  p_extern_id text,
  p_contato_normalizado text DEFAULT NULL,
  p_nome_canal text DEFAULT NULL,
  p_avatar_url text DEFAULT NULL
) RETURNS TABLE (
  resultado text,
  perfil_id uuid,
  identidade_id uuid,
  tentativas_restantes smallint,
  bloqueado_ate timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_solicitacao_id uuid;
  v_perfil_id uuid;
  v_identidade_id uuid;
  v_identidade_perfil_id uuid;
  v_tentativas smallint;
  v_janela_iniciada_em timestamptz;
  v_bloqueado_ate timestamptz;
  v_consumido_em timestamptz;
  v_expira_em timestamptz;
BEGIN
  IF p_canal NOT IN ('whatsapp', 'telegram') THEN
    RAISE EXCEPTION 'canal_invalido';
  END IF;
  IF NULLIF(trim(p_codigo), '') IS NULL OR NULLIF(trim(p_extern_id), '') IS NULL THEN
    RAISE EXCEPTION 'codigo_e_extern_id_obrigatorios';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_canal || ':' || p_extern_id, 0)
  );
  INSERT INTO public.limite_vinculo_canal (canal, extern_id)
  VALUES (p_canal, p_extern_id)
  ON CONFLICT (canal, extern_id) DO NOTHING;
  SELECT lvc.tentativas, lvc.janela_iniciada_em, lvc.bloqueado_ate
    INTO v_tentativas, v_janela_iniciada_em, v_bloqueado_ate
  FROM public.limite_vinculo_canal AS lvc
  WHERE lvc.canal = p_canal AND lvc.extern_id = p_extern_id
  FOR UPDATE;
  IF v_bloqueado_ate IS NOT NULL AND v_bloqueado_ate > now() THEN
    RETURN QUERY SELECT
      'limite_excedido'::text, NULL::uuid, NULL::uuid,
      0::smallint, v_bloqueado_ate;
    RETURN;
  END IF;
  IF v_janela_iniciada_em <= now() - interval '15 minutes' THEN
    v_tentativas := 0;
    v_janela_iniciada_em := now();
    v_bloqueado_ate := NULL;
    UPDATE public.limite_vinculo_canal
    SET tentativas = 0,
        janela_iniciada_em = v_janela_iniciada_em,
        bloqueado_ate = NULL
    WHERE canal = p_canal AND extern_id = p_extern_id;
  END IF;
  IF v_tentativas >= 5 THEN
    v_bloqueado_ate := now() + interval '30 minutes';
    UPDATE public.limite_vinculo_canal
    SET bloqueado_ate = v_bloqueado_ate,
        ultima_tentativa_em = now()
    WHERE canal = p_canal AND extern_id = p_extern_id;
    RETURN QUERY SELECT
      'limite_excedido'::text, NULL::uuid, NULL::uuid,
      0::smallint, v_bloqueado_ate;
    RETURN;
  END IF;
  UPDATE public.limite_vinculo_canal
  SET tentativas = tentativas + 1,
      ultima_tentativa_em = now()
  WHERE canal = p_canal AND extern_id = p_extern_id
  RETURNING tentativas INTO v_tentativas;
  SELECT svi.id, svi.perfil_id, svi.consumido_em, svi.expira_em
    INTO v_solicitacao_id, v_perfil_id, v_consumido_em, v_expira_em
  FROM public.solicitacao_vinculo_identidade AS svi
  WHERE svi.codigo_hash = encode(digest(upper(trim(p_codigo)), 'sha256'), 'hex')
    AND svi.canal = p_canal
  FOR UPDATE;
  IF v_solicitacao_id IS NULL THEN
    RETURN QUERY SELECT
      'codigo_invalido'::text, NULL::uuid, NULL::uuid,
      greatest(5 - v_tentativas, 0)::smallint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_consumido_em IS NOT NULL THEN
    RETURN QUERY SELECT
      'codigo_consumido'::text, NULL::uuid, NULL::uuid,
      greatest(5 - v_tentativas, 0)::smallint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_expira_em <= now() THEN
    RETURN QUERY SELECT
      'codigo_expirado'::text, NULL::uuid, NULL::uuid,
      greatest(5 - v_tentativas, 0)::smallint, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT ui.id, ui.perfil_id
    INTO v_identidade_id, v_identidade_perfil_id
  FROM public.user_identidade AS ui
  WHERE ui.canal = p_canal
    AND ui.extern_id = p_extern_id
    AND ui.revogado_em IS NULL
  FOR UPDATE;
  IF v_identidade_id IS NOT NULL AND v_identidade_perfil_id <> v_perfil_id THEN
    RETURN QUERY SELECT
      'identidade_em_conflito'::text, NULL::uuid, v_identidade_id,
      greatest(5 - v_tentativas, 0)::smallint, NULL::timestamptz;
    RETURN;
  END IF;
  IF v_identidade_id IS NULL THEN
    INSERT INTO public.user_identidade (
      perfil_id, canal, extern_id, contato_normalizado, nome_canal,
      avatar_url, verificado_em, ultima_utilizacao_em
    ) VALUES (
      v_perfil_id, p_canal, p_extern_id, p_contato_normalizado, p_nome_canal,
      p_avatar_url, now(), now()
    ) RETURNING id INTO v_identidade_id;
  ELSE
    UPDATE public.user_identidade
    SET contato_normalizado = coalesce(p_contato_normalizado, contato_normalizado),
        nome_canal = coalesce(p_nome_canal, nome_canal),
        avatar_url = coalesce(p_avatar_url, avatar_url),
        verificado_em = coalesce(verificado_em, now()),
        ultima_utilizacao_em = now()
    WHERE id = v_identidade_id;
  END IF;
  UPDATE public.solicitacao_vinculo_identidade
  SET consumido_em = now(),
      extern_id_vinculado = p_extern_id
  WHERE id = v_solicitacao_id;
  UPDATE public.limite_vinculo_canal
  SET tentativas = 0,
      janela_iniciada_em = now(),
      bloqueado_ate = NULL
  WHERE canal = p_canal AND extern_id = p_extern_id;
  RETURN QUERY SELECT
    'vinculado'::text, v_perfil_id, v_identidade_id,
    5::smallint, NULL::timestamptz;
END;
$$;

-- Revoga somente canais externos.
CREATE OR REPLACE FUNCTION public.revogar_identidade(p_identidade_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions, auth
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_perfil_id uuid;
  v_afetadas integer;
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'autenticacao_obrigatoria';
  END IF;
  SELECT id INTO v_perfil_id
  FROM public.user_perfil
  WHERE auth_user_id = v_auth_user_id;
  UPDATE public.user_identidade
  SET revogado_em = now(), revogado_por = v_perfil_id
  WHERE id = p_identidade_id
    AND perfil_id = v_perfil_id
    AND canal IN ('whatsapp', 'telegram', 'instagram')
    AND revogado_em IS NULL;
  GET DIAGNOSTICS v_afetadas = ROW_COUNT;
  RETURN v_afetadas = 1;
END;
$$;

-- Helper usado pelas policies para evitar recursão entre comanda e
-- participante_comanda. Retorna apenas um booleano e não expõe dados.
CREATE OR REPLACE FUNCTION public.pode_acessar_comanda(p_comanda_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
SELECT auth.uid() IS NOT NULL AND (
  EXISTS (
    SELECT 1
    FROM public.comanda AS c
    JOIN public.user_perfil AS cliente ON cliente.id = c.cliente_id
    WHERE c.id = p_comanda_id
      AND cliente.auth_user_id = auth.uid()
  )
  OR EXISTS (
    SELECT 1
    FROM public.participante_comanda AS pc
    JOIN public.user_perfil AS up ON up.id = pc.profissional_id
    WHERE pc.comanda_id = p_comanda_id
      AND up.auth_user_id = auth.uid()
      AND pc.status <> 'cancelado'
  )
  OR EXISTS (
    SELECT 1
    FROM public.participante_comanda AS pc
    JOIN public.loja AS l ON l.id = pc.loja_id
    JOIN public.user_perfil AS up ON up.id = l.dono_id
    WHERE pc.comanda_id = p_comanda_id
      AND up.auth_user_id = auth.uid()
      AND pc.status <> 'cancelado'
  )
);
$$;

-- Participantes consultam somente o resumo necessário para acompanhar a
-- contratação; IDs do gateway e metadados permanecem na tabela protegida.
CREATE VIEW public.pagamento_resumo
WITH (security_barrier = true)
AS
SELECT
  p.id,
  p.comanda_id,
  p.created_at,
  p.updated_at,
  p.metodo,
  p.status,
  p.valor,
  p.moeda,
  p.pago_em
FROM public.pagamento AS p
WHERE public.pode_acessar_comanda(p.comanda_id);

-- Substitui a antiga policy pública de profissional_perfil. A view é dona
-- do próprio filtro de linha (status = 'publicado') e só expõe as colunas
-- seguras de user_perfil — nome, cpf, data_nascimento, auth_user_id etc.
-- nunca aparecem aqui, mesmo que authenticated tenha SELECT amplo na tabela
-- base (RLS de user_perfil continua restrita à própria linha; esta view
-- roda com o privilégio de quem a criou, não de quem consulta).
CREATE VIEW public.profissional_publico
WITH (security_barrier = true)
AS
SELECT
  id, codigo_publico, nome_publico, slug, titulo, profissoes, bio, avatar_url,
  telefone_publico, email_publico, website_url, platform_url, provider_action_url,
  localizacao, atende_emergencia, aceita_orcamento, status,
  verificacao_identidade, verificacao_contato, verificacao_endereco, verificado_em,
  indice_confianca, jobs_concluidos, ultima_atividade_em, endereco_id
FROM public.user_perfil
WHERE status = 'publicado';

-- Avaliação só nasce de uma comanda concluída e de um participante real.
CREATE OR REPLACE FUNCTION public.criar_avaliacao(
  p_comanda_id uuid,
  p_nota smallint,
  p_profissional_id uuid DEFAULT NULL,
  p_loja_id uuid DEFAULT NULL,
  p_titulo text DEFAULT NULL,
  p_comentario text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_auth_user_id uuid := auth.uid();
  v_autor_id uuid;
  v_avaliacao_id uuid;
BEGIN
  IF v_auth_user_id IS NULL THEN
    RAISE EXCEPTION 'autenticacao_obrigatoria';
  END IF;
  IF p_nota NOT BETWEEN 1 AND 5 THEN
    RAISE EXCEPTION 'nota_invalida';
  END IF;
  IF num_nonnulls(p_profissional_id, p_loja_id) <> 1 THEN
    RAISE EXCEPTION 'informe_exatamente_um_avaliado';
  END IF;
  SELECT up.id INTO v_autor_id
  FROM public.user_perfil AS up
  JOIN public.comanda AS c ON c.cliente_id = up.id
  WHERE up.auth_user_id = v_auth_user_id
    AND c.id = p_comanda_id
    AND c.status = 'concluida';
  IF v_autor_id IS NULL THEN
    RAISE EXCEPTION 'comanda_nao_concluida_ou_nao_pertence_ao_usuario';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.participante_comanda AS pc
    WHERE pc.comanda_id = p_comanda_id
      AND pc.status = 'concluido'
      AND (
        (p_profissional_id IS NOT NULL AND pc.profissional_id = p_profissional_id)
        OR (p_loja_id IS NOT NULL AND pc.loja_id = p_loja_id)
      )
  ) THEN
    RAISE EXCEPTION 'avaliado_nao_participou_da_contratacao';
  END IF;
  INSERT INTO public.avaliacao (
    comanda_id, autor_id, profissional_id, loja_id,
    nota, titulo, comentario, publica, verificada
  ) VALUES (
    p_comanda_id, v_autor_id, p_profissional_id, p_loja_id,
    p_nota, nullif(trim(p_titulo), ''), nullif(trim(p_comentario), ''),
    true, true
  ) RETURNING id INTO v_avaliacao_id;
  RETURN v_avaliacao_id;
END;
$$;

-- =============================================================================
-- RPCs DE IA COPILOTO
-- =============================================================================
CREATE OR REPLACE FUNCTION public.criar_ia_copiloto(
  p_nome text,
  p_descricao text DEFAULT NULL,
  p_api_key text DEFAULT NULL,
  p_escopos text[] DEFAULT '{ler_necessidades,criar_necessidades,ler_solutions}'::text[],
  p_requisicoes_por_minuto integer DEFAULT 60
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_id uuid;
  v_hash text;
  v_prefix text;
BEGIN
  IF length(p_api_key) < 32 THEN
    RAISE EXCEPTION 'api_key_muito_curta';
  END IF;
  v_hash := encode(digest(p_api_key, 'sha256'), 'hex');
  v_prefix := substring(p_api_key from 1 for 8);
  INSERT INTO public.ia_copiloto (
    nome, descricao, api_key_hash, api_key_prefix,
    escopos, requisicoes_por_minuto
  ) VALUES (
    p_nome, p_descricao, v_hash, v_prefix,
    p_escopos, p_requisicoes_por_minuto
  ) RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.autenticar_ia_copiloto(p_api_key text)
RETURNS TABLE (
  ia_copiloto_id uuid,
  nome text,
  escopos text[],
  requisicoes_por_minuto integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_hash text;
  v_prefix text;
  v_ia_id uuid;
BEGIN
  v_hash := encode(digest(p_api_key, 'sha256'), 'hex');
  v_prefix := substring(p_api_key from 1 for 8);
  SELECT ic.id, ic.nome, ic.escopos, ic.requisicoes_por_minuto
  INTO v_ia_id, nome, escopos, requisicoes_por_minuto
  FROM public.ia_copiloto ic
  WHERE ic.api_key_prefix = v_prefix
    AND ic.api_key_hash = v_hash
    AND ic.ativo = true
    AND ic.revogado_em IS NULL;
  IF v_ia_id IS NULL THEN
    RAISE EXCEPTION 'ia_nao_autenticada';
  END IF;
  UPDATE public.ia_copiloto
  SET requisicoes_hoje = requisicoes_hoje + 1,
      ultima_requisicao_em = now()
  WHERE id = v_ia_id;
  ia_copiloto_id := v_ia_id;
  RETURN NEXT;
END;
$$;

-- =============================================================================
-- RLS DEFAULT-DENY
-- =============================================================================
ALTER TABLE public.user_perfil ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_identidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.aceite_legal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solicitacao_vinculo_identidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.limite_vinculo_canal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.localidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.termo_busca ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.endereco ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loja ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.area_atendimento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credencial_profissional ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apolice_seguro ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.midia_profissional ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disponibilidade_semanal ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bloqueio_agenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.favorito ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visualizacao_recente ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.necessidade ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solution ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.solution_acesso ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comanda ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participante_comanda ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.divisao_pagamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.avaliacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.preco_termo_regiao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pagina_seo ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.url_redirect ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ia_copiloto ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ia_copiloto_log ENABLE ROW LEVEL SECURITY;

-- =============================================================================
-- POLICIES MÍNIMAS
-- =============================================================================
-- Catálogo público. Escritas continuam exclusivas do backend/service_role.
CREATE POLICY localidade_publica_select ON public.localidade
  FOR SELECT TO anon, authenticated USING (ativo = true);
CREATE POLICY termo_busca_publico_select ON public.termo_busca
  FOR SELECT TO anon, authenticated USING (ativo = true);
CREATE POLICY loja_publica_select ON public.loja
  FOR SELECT TO anon, authenticated USING (status = 'publicado');
-- profissional_publico_select foi removida: a exposição pública de dados
-- profissionais agora passa pela view public.profissional_publico, que só
-- expõe colunas seguras. Nenhuma policy nova é necessária em user_perfil.
CREATE POLICY item_publico_select ON public.item
  FOR SELECT TO anon, authenticated USING (
    status = 'publicado' AND disponivel = true
  );
CREATE POLICY pagina_seo_publica_select ON public.pagina_seo
  FOR SELECT TO anon, authenticated USING (indexavel = true);
CREATE POLICY preco_termo_regiao_publico_select ON public.preco_termo_regiao
  FOR SELECT TO anon, authenticated USING (tamanho_amostra > 0);

-- Dados privados do dono autenticado.
CREATE POLICY aceite_legal_select_proprio ON public.aceite_legal
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.user_perfil up
      WHERE up.id = aceite_legal.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );

CREATE POLICY user_perfil_proprio_select ON public.user_perfil
  FOR SELECT TO authenticated USING (auth_user_id = auth.uid());
CREATE POLICY user_perfil_proprio_update ON public.user_perfil
  FOR UPDATE TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());
CREATE POLICY user_identidade_propria_select ON public.user_identidade
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = user_identidade.perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY solution_proprio_select ON public.solution
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = solution.perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY necessidade_propria_select ON public.necessidade
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = necessidade.user_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY favorito_proprio_all ON public.favorito
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = favorito.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = favorito.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY visualizacao_propria_all ON public.visualizacao_recente
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = visualizacao_recente.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = visualizacao_recente.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
-- Endereços: o cliente administra os próprios. Prestador/loja só recebe o
-- endereço completo depois de aceitar e entrar no estágio operacional.
CREATE POLICY endereco_proprio_select ON public.endereco
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = endereco.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY endereco_operacao_select ON public.endereco
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.comanda c
      JOIN public.participante_comanda pc ON pc.comanda_id = c.id
      LEFT JOIN public.user_perfil upp ON upp.id = pc.profissional_id
      LEFT JOIN public.loja l ON l.id = pc.loja_id
      LEFT JOIN public.user_perfil upl ON upl.id = l.dono_id
      WHERE c.endereco_id = endereco.id
        AND c.status IN ('aceita', 'em_andamento', 'aguardando_aceite', 'concluida')
        AND pc.status IN ('aceito', 'executando', 'concluido')
        AND (upp.auth_user_id = auth.uid() OR upl.auth_user_id = auth.uid())
    )
  );
CREATE POLICY endereco_proprio_insert ON public.endereco
  FOR INSERT TO authenticated WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = endereco.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY endereco_proprio_update ON public.endereco
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = endereco.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = endereco.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
CREATE POLICY endereco_proprio_delete ON public.endereco
  FOR DELETE TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = endereco.user_perfil_id
        AND up.auth_user_id = auth.uid()
    )
  );
-- Cliente e participantes conseguem acompanhar a mesma comanda.
CREATE POLICY comanda_partes_select ON public.comanda
  FOR SELECT TO authenticated USING (public.pode_acessar_comanda(id));
-- Cliente vê a composição inteira; cada participante vê a própria linha.
CREATE POLICY participante_comanda_partes_select ON public.participante_comanda
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.comanda c
      JOIN public.user_perfil cliente ON cliente.id = c.cliente_id
      WHERE c.id = participante_comanda.comanda_id
        AND cliente.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.user_perfil up
      WHERE up.id = participante_comanda.profissional_id
        AND up.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.loja l
      JOIN public.user_perfil up ON up.id = l.dono_id
      WHERE l.id = participante_comanda.loja_id
        AND up.auth_user_id = auth.uid()
    )
  );
-- A tabela completa de pagamento fica visível apenas para o cliente. As
-- partes usam pagamento_resumo, que não contém gateway IDs nem metadados.
CREATE POLICY pagamento_cliente_select ON public.pagamento
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.comanda c
      JOIN public.user_perfil cliente ON cliente.id = c.cliente_id
      WHERE c.id = pagamento.comanda_id
        AND cliente.auth_user_id = auth.uid()
    )
  );
-- Cliente vê todas as divisões; participante vê somente o próprio repasse.
CREATE POLICY divisao_pagamento_partes_select ON public.divisao_pagamento
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1
      FROM public.pagamento p
      JOIN public.comanda c ON c.id = p.comanda_id
      JOIN public.user_perfil cliente ON cliente.id = c.cliente_id
      WHERE p.id = divisao_pagamento.pagamento_id
        AND cliente.auth_user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.participante_comanda pc
      LEFT JOIN public.user_perfil upp ON upp.id = pc.profissional_id
      LEFT JOIN public.loja l ON l.id = pc.loja_id
      LEFT JOIN public.user_perfil upl ON upl.id = l.dono_id
      WHERE pc.id = divisao_pagamento.participante_id
        AND (upp.auth_user_id = auth.uid() OR upl.auth_user_id = auth.uid())
    )
  );
CREATE POLICY avaliacao_publica_select ON public.avaliacao
  FOR SELECT TO anon, authenticated USING (publica = true AND verificada = true);
CREATE POLICY avaliacao_autor_select ON public.avaliacao
  FOR SELECT TO authenticated USING (
    EXISTS (
      SELECT 1 FROM public.user_perfil up
      WHERE up.id = avaliacao.autor_id
        AND up.auth_user_id = auth.uid()
    )
  );

-- IA Copiloto: service_role tem acesso total; log é restrito ao dono da IA.
CREATE POLICY ia_copiloto_service_role_all ON public.ia_copiloto
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY ia_copiloto_log_service_role_all ON public.ia_copiloto_log
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

-- =============================================================================
-- GRANTS
-- =============================================================================
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON TABLE
  public.localidade,
  public.termo_busca,
  public.loja,
  public.profissional_publico,
  public.item,
  public.habilidade,
  public.preco_termo_regiao,
  public.pagina_seo,
  public.avaliacao
  TO anon, authenticated;
GRANT SELECT ON TABLE
  public.user_perfil,
  public.user_identidade,
  public.aceite_legal,
  public.solution,
  public.necessidade,
  public.endereco,
  public.comanda,
  public.participante_comanda,
  public.pagamento,
  public.divisao_pagamento
  TO authenticated;
GRANT SELECT ON public.pagamento_resumo TO authenticated;
-- Campos pessoais + os que a pessoa preenche pra publicar (anunciar
-- habilidades). codigo_publico fica de fora (gerado pelo sistema).
GRANT UPDATE (
  nome, cpf, apelido, data_nascimento, avatar_url, locale,
  endereco_id, nome_publico, slug, titulo, profissoes, bio, telefone_publico,
  email_publico, website_url, atende_emergencia, aceita_orcamento, status
)
  ON public.user_perfil TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.endereco TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.favorito TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visualizacao_recente TO authenticated;
GRANT EXECUTE ON FUNCTION public.uuidv7() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.normalizar_busca(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.obter_ou_criar_perfil_canal(text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.criar_acesso_solution(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.vincular_identidade_por_codigo(text, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.reivindicar_solution(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.criar_codigo_vinculo_canal(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.revogar_identidade(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.criar_avaliacao(uuid, smallint, uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pode_acessar_comanda(uuid) TO authenticated, anon;
REVOKE ALL ON FUNCTION public.criar_ia_copiloto(text, text, text, text[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.criar_ia_copiloto(text, text, text, text[], integer) TO service_role;
REVOKE ALL ON FUNCTION public.autenticar_ia_copiloto(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.autenticar_ia_copiloto(text) TO anon, authenticated, service_role;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- =============================================================================
-- COMENTÁRIOS DE NEGÓCIO
-- =============================================================================
COMMENT ON FUNCTION public.normalizar_busca(text) IS
  'Normaliza texto comercial para comparação sem acentos; não interpreta intenção nem problemas.';
COMMENT ON TABLE public.aceite_legal IS
  'Registro auditável do aceite de documentos legais por um perfil autenticado.';
COMMENT ON COLUMN public.aceite_legal.versao IS
  'Versão imutável do documento apresentado no momento do aceite.';
COMMENT ON COLUMN public.user_perfil.codigo_publico IS
  'Identificador público estável, gerado pra qualquer conta; permanece o mesmo mesmo quando slug muda.';
COMMENT ON COLUMN public.user_perfil.indice_confianca IS
  'Sinal interno composto por identidade, contato, endereço, credenciais, seguro, disponibilidade e operação; não depende de avaliações. Só relevante para contas com status = publicado.';
COMMENT ON TABLE public.area_atendimento IS
  'Cobertura real do profissional por localidade, raio ou polígono.';
COMMENT ON TABLE public.pagina_seo IS
  'Controle editorial de páginas indexáveis. Página nova não entra automaticamente no sitemap.';
COMMENT ON COLUMN public.pagina_seo.profissionais_ativos IS
  'Oferta real disponível na combinação serviço/localidade; avaliações não são requisito.';
COMMENT ON TABLE public.visualizacao_recente IS
  'Uma linha por usuário e alvo; a aplicação atualiza visto_em e total_visitas em cada visita.';
COMMENT ON TABLE public.necessidade IS
  'Relato do problema tal como o usuário descreveu; fonte de verdade. Gera uma ou mais solutions.';
COMMENT ON COLUMN public.necessidade.descricao_necessidade IS
  'Texto livre do problema — fonte de verdade. Nunca sobrescrito pela IA.';
COMMENT ON COLUMN public.necessidade.mensagem_origem IS
  'Mensagem original do usuário preservada para auditoria e reprocessamento.';
COMMENT ON COLUMN public.necessidade.token_compartilhamento_hash IS
  'SHA-256 do token de compartilhamento; usado para lookup do link público.';
COMMENT ON COLUMN public.necessidade.ia_copiloto_id IS
  'IA que originou a necessidade; NULL quando criada diretamente pelo usuário.';
COMMENT ON TABLE public.solution IS
  'Proposta concreta gerada para uma necessidade. Pode haver várias por necessidade.';
COMMENT ON COLUMN public.solution.posicao IS
  'Ordem de apresentação da solution para o usuário.';
COMMENT ON COLUMN public.solution.valor_total IS
  'Valor total da solution (sem adicionais). Adicionais ficam em conteudo.adicionais.';
COMMENT ON TABLE public.solution_acesso IS
  'Token de passagem WhatsApp para navegador armazenado somente como hash, com expiração e consumo único.';
COMMENT ON COLUMN public.user_perfil.auth_user_id IS
  'Vínculo opcional com auth.users; começa NULL quando o perfil nasce em um canal externo.';
COMMENT ON TABLE public.solicitacao_vinculo_identidade IS
  'Código temporário criado na web e consumido somente pelo backend após receber a mensagem do canal real.';
COMMENT ON TABLE public.ia_copiloto IS
  'Autenticação e licenciamento para IAs externas (Copiloto). A chave API é armazenada apenas como hash.';
COMMENT ON COLUMN public.ia_copiloto.api_key_prefix IS
  'Prefixo público da chave API para identificação (ex: sk_live_abc123). Usado para lookup antes do hash.';
COMMENT ON COLUMN public.ia_copiloto.escopos IS
  'Permissões da IA: ler_necessidades, criar_necessidades, ler_solutions, criar_contratacoes, ler_contratacoes, admin.';
COMMENT ON TABLE public.ia_copiloto_log IS
  'Auditoria de chamadas de API das IAs copiloto. Usado para rate limiting e troubleshooting.';

COMMIT;