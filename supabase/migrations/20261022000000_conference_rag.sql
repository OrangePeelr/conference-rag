CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.sentence_embeddings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    talk_id uuid NOT NULL,
    title text NOT NULL,
    speaker text,
    calling text,
    year integer,
    season text,
    url text,
    sentence_num integer,
    text text NOT NULL,
    embedding extensions.vector(1536),
    created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sentence_embeddings_talk_id_idx
    ON public.sentence_embeddings (talk_id, sentence_num);
CREATE INDEX IF NOT EXISTS sentence_embeddings_speaker_idx
    ON public.sentence_embeddings (speaker);
CREATE INDEX IF NOT EXISTS sentence_embeddings_cosine_idx
    ON public.sentence_embeddings USING hnsw (embedding extensions.vector_cosine_ops);

ALTER TABLE public.sentence_embeddings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sentence_embeddings FROM anon, authenticated;
GRANT SELECT ON public.sentence_embeddings TO anon, authenticated;
GRANT ALL ON public.sentence_embeddings TO service_role;
DROP POLICY IF EXISTS "Allow authenticated users to read" ON public.sentence_embeddings;
CREATE POLICY "Allow authenticated users to read"
    ON public.sentence_embeddings FOR SELECT TO authenticated USING (true);

-- Deliberately public for the assignment's RLS comparison exercise.
CREATE TABLE IF NOT EXISTS public.page_views (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    visited_at timestamptz DEFAULT now(),
    page_url text,
    user_agent text
);
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.page_views FROM anon, authenticated;
GRANT SELECT, INSERT ON public.page_views TO anon, authenticated;
GRANT ALL ON public.page_views TO service_role;
DROP POLICY IF EXISTS "Allow public inserts" ON public.page_views;
CREATE POLICY "Allow public inserts" ON public.page_views
    FOR INSERT TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "Allow public reads" ON public.page_views;
CREATE POLICY "Allow public reads" ON public.page_views
    FOR SELECT TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.match_sentences(
    query_embedding extensions.vector(1536), match_count integer DEFAULT 20,
    filter_speaker text DEFAULT NULL
)
RETURNS TABLE (
    id uuid, talk_id uuid, title text, speaker text, url text,
    text text, similarity double precision
)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, extensions
SET hnsw.iterative_scan = strict_order
SET hnsw.ef_search = 100
AS $$
DECLARE safe_count integer := greatest(1, least(coalesce(match_count, 20), 100));
BEGIN
    IF query_embedding IS NULL THEN RETURN; END IF;
    -- Replan with actual arguments. A generic plan for an optional speaker OR
    -- predicate can prefer a full vector scan, exceeding the API timeout.
    -- Values remain bound parameters; neither branch interpolates user input.
    IF filter_speaker IS NULL THEN
        RETURN QUERY EXECUTE '
            SELECT s.id, s.talk_id, s.title, s.speaker, s.url, s.text,
                   1 - (s.embedding <=> $1) AS similarity
            FROM public.sentence_embeddings s
            WHERE s.embedding IS NOT NULL
            ORDER BY s.embedding <=> $1 LIMIT $2'
        USING query_embedding, safe_count;
    ELSE
        RETURN QUERY EXECUTE '
            SELECT s.id, s.talk_id, s.title, s.speaker, s.url, s.text,
                   1 - (s.embedding <=> $1) AS similarity
            FROM public.sentence_embeddings s
            WHERE s.embedding IS NOT NULL AND s.speaker = $3
            ORDER BY s.embedding <=> $1 LIMIT $2'
        USING query_embedding, safe_count, filter_speaker;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.match_sentences(extensions.vector, integer, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_sentences(extensions.vector, integer, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_speakers()
RETURNS TABLE (speaker text) LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
    SELECT DISTINCT s.speaker FROM public.sentence_embeddings s
    WHERE s.speaker IS NOT NULL ORDER BY s.speaker;
$$;
REVOKE ALL ON FUNCTION public.list_speakers() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_speakers() TO authenticated, service_role;

-- One row per user; concurrent requests share a database-enforced quota.
CREATE TABLE IF NOT EXISTS public.ai_usage (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    window_start timestamptz NOT NULL,
    requests integer NOT NULL
);
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ai_usage FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.consume_ai_quota()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_user_id uuid := auth.uid(); accepted boolean;
BEGIN
    IF current_user_id IS NULL THEN RETURN false; END IF;
    INSERT INTO public.ai_usage AS usage (user_id, window_start, requests)
    VALUES (current_user_id, now(), 1)
    ON CONFLICT (user_id) DO UPDATE SET
        window_start = CASE WHEN usage.window_start <= now() - interval '1 minute'
                            THEN now() ELSE usage.window_start END,
        requests = CASE WHEN usage.window_start <= now() - interval '1 minute'
                        THEN 1 ELSE usage.requests + 1 END
    WHERE usage.window_start <= now() - interval '1 minute' OR usage.requests < 20
    RETURNING true INTO accepted;
    RETURN coalesce(accepted, false);
END;
$$;
REVOKE ALL ON FUNCTION public.consume_ai_quota() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota() TO authenticated;
