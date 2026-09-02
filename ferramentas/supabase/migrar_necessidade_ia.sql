-- =============================================================================
-- MIGRAÇÃO: necessidade acessível por I.A. copiloto SEM humano vinculado
-- Executar no Supabase SQL Editor (Dashboard > SQL Editor > New Query)
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- PROBLEMA 1: user_id é NOT NULL com FK para user_perfil
-- A I.A. cria necessidades sem usuário humano autenticado.
-- Solução: tornar user_id NULLABLE (a constraint de FK permanece para quando
-- houver um humano, mas deixa de ser obrigatória para fluxos de I.A.)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.necessidade
  ALTER COLUMN user_id DROP NOT NULL;

COMMENT ON COLUMN public.necessidade.user_id IS
  'NULL quando a necessidade é criada por uma I.A. copiloto sem usuário humano vinculado. '
  'O ia_copiloto_id identifica quem criou nesse caso.';

-- ─────────────────────────────────────────────────────────────────────────────
-- PROBLEMA 2: expira_em é NOT NULL sem valor padrão
-- PostgREST rejeita o INSERT quando o campo não é enviado.
-- Solução: adicionar DEFAULT de NOW() + 6 meses
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.necessidade
  ALTER COLUMN expira_em SET DEFAULT (now() + interval '6 months');

COMMENT ON COLUMN public.necessidade.expira_em IS
  'Prazo de validade da necessidade. Padrão: 6 meses a partir da criação. '
  'Após esse prazo, a necessidade pode ser marcada como expirada automaticamente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- PROBLEMA 3: urgencia_enum só aceita 'baixa','media','alta','emergencia'
-- As I.A.s enviam valores como 'urgente' e 'agendado' que são rejeitados.
-- Solução: expandir o enum com os novos valores
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE public.urgencia_enum ADD VALUE IF NOT EXISTS 'urgente';
ALTER TYPE public.urgencia_enum ADD VALUE IF NOT EXISTS 'agendado';

COMMENT ON TYPE public.urgencia_enum IS
  'Níveis de urgência: baixa, media, alta, emergencia (originais) + urgente, agendado (adicionados para I.A.)';

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICAÇÃO: confirmar que as alterações foram aplicadas
-- ─────────────────────────────────────────────────────────────────────────────

-- Deve retornar user_id como is_nullable = YES
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'necessidade'
  AND column_name IN ('user_id', 'expira_em', 'urgencia')
ORDER BY column_name;

-- Deve listar todos os valores do enum incluindo 'urgente' e 'agendado'
SELECT unnest(enum_range(NULL::public.urgencia_enum)) AS valor_enum;
