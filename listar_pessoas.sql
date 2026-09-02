-- =============================================================================
-- LISTAR PESSOAS — busca de profissionais com filtros combináveis
--
-- Filtros (todos opcionais, combináveis entre si com E lógico):
--   p_busca            texto livre: casa com nome público, título, bio,
--                      profissões e nomes de habilidades (sem acento, trgm)
--   p_profissoes       lista de profissões: casa com user_perfil.profissoes[]
--   p_habilidades      lista de habilidades: casa com item (tipo 'habilidade')
--                      publicado da pessoa
--   p_cidade           cidade do endereço do perfil (sem acento)
--   p_idade_min / max  idade calculada a partir de data_nascimento
--   p_criado_apos/ate  range de tempo de cadastro (created_at)
--   p_ativo_apos       só quem teve atividade a partir desta data
--   p_preco_min / max  faixa de preço das habilidades (interseção com
--                      preco_min/preco_max do item)
--   p_atende_emergencia  true = só quem atende emergência
--   p_apenas_publicados  true (padrão) = só status 'publicado'
--   p_limite / p_offset paginação (limite máx. 100)
--
-- Retorna o "total" (COUNT(*) OVER) para paginação e as habilidades
-- correspondentes de cada pessoa como jsonb.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.listar_pessoas(
  p_busca             text        DEFAULT NULL,
  p_profissoes        text[]      DEFAULT NULL,
  p_habilidades       text[]      DEFAULT NULL,
  p_cidade            text        DEFAULT NULL,
  p_idade_min         integer     DEFAULT NULL,
  p_idade_max         integer     DEFAULT NULL,
  p_criado_apos       timestamptz DEFAULT NULL,
  p_criado_ate        timestamptz DEFAULT NULL,
  p_ativo_apos        timestamptz DEFAULT NULL,
  p_preco_min         numeric     DEFAULT NULL,
  p_preco_max         numeric     DEFAULT NULL,
  p_atende_emergencia boolean     DEFAULT NULL,
  p_apenas_publicados boolean     DEFAULT true,
  p_limite            integer     DEFAULT 20,
  p_offset            integer     DEFAULT 0
)
RETURNS TABLE (
  id                 uuid,
  codigo_publico     varchar,
  nome_publico       varchar,
  slug               varchar,
  titulo             varchar,
  bio                text,
  avatar_url         text,
  profissoes         text[],
  cidade             varchar,
  estado             varchar,
  idade              integer,
  atende_emergencia  boolean,
  indice_confianca   numeric,
  jobs_concluidos    integer,
  verificacao_identidade status_verificacao_enum,
  ultima_atividade_em    timestamptz,
  habilidades            jsonb,
  total                  bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, extensions
AS $$
BEGIN
  p_limite := least(coalesce(p_limite, 20), 100);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  RETURN QUERY
  WITH filtro_habilidades AS (
    -- Pessoas que têm ALGUMA habilidade da lista informada
    SELECT DISTINCT i.profissional_id
    FROM public.item i
    WHERE i.profissional_id IS NOT NULL
      AND i.tipo_oferta = 'habilidade'
      AND i.status = 'publicado'
      AND p_habilidades IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(p_habilidades) AS h
        WHERE i.nome ILIKE '%' || h || '%'
           OR public.normalizar_busca(i.nome) LIKE public.normalizar_busca(h) || '%'
           OR similarity(i.nome, h) > 0.2
      )
  ),
  pessoas AS (
    SELECT
      up.*,
      (SELECT e.cidade FROM public.endereco e WHERE e.id = up.endereco_id) AS _cidade,
      (SELECT e.estado FROM public.endereco e WHERE e.id = up.endereco_id) AS _estado,
      CASE WHEN up.data_nascimento IS NOT NULL
        THEN extract(year FROM age(now(), up.data_nascimento))::integer
      END AS _idade
    FROM public.user_perfil up
    WHERE up.nome_publico IS NOT NULL
      AND up.slug IS NOT NULL
      -- publicado
      AND (p_apenas_publicados = false OR up.status = 'publicado')
      -- cidade
      AND (
        p_cidade IS NULL
        OR EXISTS (
          SELECT 1 FROM public.endereco e
          WHERE e.id = up.endereco_id
            AND public.normalizar_busca(e.cidade) = public.normalizar_busca(p_cidade)
        )
      )
      -- idade (range)
      AND (p_idade_min IS NULL OR up.data_nascimento IS NOT NULL
           AND extract(year FROM age(now(), up.data_nascimento)) >= p_idade_min)
      AND (p_idade_max IS NULL OR up.data_nascimento IS NOT NULL
           AND extract(year FROM age(now(), up.data_nascimento)) <= p_idade_max)
      -- range de tempo de cadastro
      AND (p_criado_apos IS NULL OR up.created_at >= p_criado_apos)
      AND (p_criado_ate  IS NULL OR up.created_at <= p_criado_ate)
      -- atividade recente
      AND (p_ativo_apos IS NULL OR up.ultima_atividade_em >= p_ativo_apos)
      -- emergência
      AND (p_atende_emergencia IS NULL
           OR p_atende_emergencia = false
           OR up.atende_emergencia = true)
      -- profissões
      AND (
        p_profissoes IS NULL
        OR EXISTS (
          SELECT 1
          FROM unnest(p_profissoes) AS prof
          WHERE EXISTS (
            SELECT 1
            FROM unnest(up.profissoes) AS minha
            WHERE public.normalizar_busca(minha) LIKE public.normalizar_busca(prof) || '%'
               OR similarity(minha, prof) > 0.25
          )
        )
      )
      -- habilidades
      AND (p_habilidades IS NULL OR up.id IN (SELECT profissional_id FROM filtro_habilidades))
      -- busca livre: nome, título, bio, profissões ou habilidades
      AND (
        p_busca IS NULL
        OR up.nome_publico ILIKE '%' || p_busca || '%'
        OR coalesce(up.titulo, '')    ILIKE '%' || p_busca || '%'
        OR coalesce(up.bio, '')       ILIKE '%' || p_busca || '%'
        OR EXISTS (SELECT 1 FROM unnest(up.profissoes) pr
                   WHERE public.normalizar_busca(pr) LIKE public.normalizar_busca(p_busca) || '%')
        OR EXISTS (
          SELECT 1 FROM public.item i
          WHERE i.profissional_id = up.id
            AND i.tipo_oferta = 'habilidade'
            AND i.status = 'publicado'
            AND (i.nome ILIKE '%' || p_busca || '%'
                 OR public.normalizar_busca(i.nome) LIKE public.normalizar_busca(p_busca) || '%'
                 OR similarity(i.nome, p_busca) > 0.2)
        )
      )
  )
  SELECT
    p.id,
    p.codigo_publico,
    p.nome_publico,
    p.slug,
    p.titulo,
    p.bio,
    p.avatar_url,
    p.profissoes,
    p._cidade,
    p._estado,
    p._idade,
    p.atende_emergencia,
    p.indice_confianca,
    p.jobs_concluidos,
    p.verificacao_identidade,
    p.ultima_atividade_em,
    -- Habilidades publicadas (aplicando o filtro de faixa de preço, se houver)
    (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', i.id, 'nome', i.nome, 'slug', i.slug,
        'tipo_preco', i.tipo_preco, 'preco_min', i.preco_min, 'preco_max', i.preco_max,
        'nome_metrica', i.nome_metrica, 'valor_metrica', i.valor_metrica
      ) ORDER BY i.nome), '[]'::jsonb)
      FROM public.item i
      WHERE i.profissional_id = p.id
        AND i.tipo_oferta = 'habilidade'
        AND i.status = 'publicado'
        AND (p_preco_min IS NULL OR coalesce(i.preco_max, i.preco_min) >= p_preco_min)
        AND (p_preco_max IS NULL OR coalesce(i.preco_min, i.preco_max) <= p_preco_max)
    ),
    count(*) OVER () AS total
  FROM pessoas p
  ORDER BY p.indice_confianca DESC, p.jobs_concluidos DESC, p.nome_publico
  LIMIT p_limite OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.listar_pessoas(
  text, text[], text[], text, integer, integer,
  timestamptz, timestamptz, timestamptz,
  numeric, numeric, boolean, boolean, integer, integer
) TO anon, authenticated, service_role;
