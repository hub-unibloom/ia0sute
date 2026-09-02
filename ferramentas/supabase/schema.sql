-- Schema PostgreSQL / Supabase para o Projeto Site da I.A.

CREATE TABLE IF NOT EXISTS public.requisicoes_ia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payload_raw JSONB,
    url_origem TEXT,
    etapa_calculada TEXT DEFAULT '1',
    status TEXT DEFAULT 'recebido',
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    atualizado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pedidos_ia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    codigo_necessidade VARCHAR(100) UNIQUE NOT NULL,
    dados_pedido JSONB DEFAULT '{}'::jsonb,
    etapa_atual INT DEFAULT 1,
    orientacao_ia TEXT,
    criado_em TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Políticas RLS (Row Level Security)
ALTER TABLE public.requisicoes_ia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pedidos_ia ENABLE ROW LEVEL SECURITY;
