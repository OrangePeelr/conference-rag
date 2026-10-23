-- A talk-level keyword index complements the existing sentence vectors.
-- Keeping one lexical result per talk avoids rewarding long talks merely
-- because their speaker/title metadata is repeated on every sentence.
CREATE TABLE IF NOT EXISTS public.conference_talks (
    talk_id uuid PRIMARY KEY,
    title text NOT NULL,
    speaker text,
    calling text,
    year integer,
    season text,
    url text,
    text text NOT NULL,
    search_document tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(speaker, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(calling, '') || ' ' ||
            coalesce(year::text, '') || ' ' || coalesce(season, '')), 'B') ||
        setweight(to_tsvector('english', text), 'D')
    ) STORED
);
CREATE INDEX IF NOT EXISTS conference_talks_search_idx
    ON public.conference_talks USING gin (search_document);
CREATE INDEX IF NOT EXISTS conference_talks_date_idx
    ON public.conference_talks (year, season);

ALTER TABLE public.conference_talks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conference_talks FROM anon, authenticated;
GRANT SELECT ON public.conference_talks TO anon, authenticated;
GRANT ALL ON public.conference_talks TO service_role;
DROP POLICY IF EXISTS "Read talks after login" ON public.conference_talks;
CREATE POLICY "Read talks after login" ON public.conference_talks
    FOR SELECT TO authenticated USING (true);

-- Backfill from the corpus without regenerating or changing any embeddings.
INSERT INTO public.conference_talks (talk_id, title, speaker, calling, year, season, url, text)
SELECT talk_id, min(title), min(speaker), min(calling), min(year), min(season),
       min(url), string_agg(text, ' ' ORDER BY sentence_num)
FROM public.sentence_embeddings GROUP BY talk_id
ON CONFLICT (talk_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.hybrid_search_talks(
    query_text text DEFAULT '',
    query_embedding extensions.vector(1536) DEFAULT NULL,
    match_count integer DEFAULT 8,
    filter_author text DEFAULT NULL,
    filter_title text DEFAULT NULL,
    year_from integer DEFAULT NULL,
    year_to integer DEFAULT NULL,
    filter_season text DEFAULT NULL
)
RETURNS TABLE (
    talk_id uuid, title text, speaker text, year integer, season text, url text,
    text text, excerpt text, score double precision,
    keyword_match boolean, semantic_match boolean, filtered_talk_count bigint
)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = public, extensions
SET hnsw.iterative_scan = strict_order
SET hnsw.ef_search = 100
AS $$
DECLARE
    search_text text := trim(coalesce(query_text, ''));
    author_text text := nullif(trim(filter_author), '');
    title_text text := nullif(trim(filter_title), '');
    season_text text := nullif(trim(filter_season), '');
    safe_count integer := greatest(1, least(coalesce(match_count, 8), 8));
    vector_source text;
BEGIN
    IF length(search_text) > 2000 OR length(author_text) > 500 OR length(title_text) > 500 THEN
        RAISE EXCEPTION 'Search text or filter is too long' USING ERRCODE = '22023';
    END IF;
    IF year_from > year_to THEN
        RAISE EXCEPTION 'Start year must not follow end year' USING ERRCODE = '22023';
    END IF;
    IF season_text IS NOT NULL AND season_text NOT IN ('April', 'October') THEN
        RAISE EXCEPTION 'Choose April or October' USING ERRCODE = '22023';
    END IF;

    -- Use HNSW for the whole corpus. For a restricted collection, materialize
    -- eligible sentences first: otherwise HNSW can scan almost the entire
    -- corpus trying to find 200 rows from a small author/date subset.
    IF author_text IS NULL AND title_text IS NULL AND year_from IS NULL
        AND year_to IS NULL AND season_text IS NULL THEN
        vector_source := 'SELECT s.talk_id, s.text, s.embedding <=> $1 AS distance
            FROM public.sentence_embeddings s
            WHERE $1 IS NOT NULL AND s.embedding IS NOT NULL
            ORDER BY s.embedding <=> $1 LIMIT 200';
    ELSE
        vector_source := 'WITH eligible AS MATERIALIZED (
                SELECT s.talk_id, s.text, s.embedding
                FROM public.sentence_embeddings s JOIN filtered f ON f.talk_id = s.talk_id
                WHERE $1 IS NOT NULL AND s.embedding IS NOT NULL
            )
            SELECT e.talk_id, e.text, e.embedding <=> $1 AS distance
            FROM eligible e ORDER BY e.embedding <=> $1 LIMIT 200';
    END IF;
    -- Only trusted SQL fragments are interpolated; user values remain bound.
    RETURN QUERY EXECUTE format($query$
        WITH filtered AS MATERIALIZED (
            SELECT t.* FROM public.conference_talks t
            WHERE ($3 IS NULL OR to_tsvector('simple', coalesce(t.speaker, ''))
                @@ plainto_tsquery('simple', $3))
              AND ($4 IS NULL OR strpos(lower(t.title), lower($4)) > 0)
              AND ($5 IS NULL OR t.year >= $5)
              AND ($6 IS NULL OR t.year <= $6)
              AND ($7 IS NULL OR t.season = $7)
        ), lexical AS MATERIALIZED (
            SELECT t.talk_id,
                row_number() OVER (ORDER BY ts_rank_cd(t.search_document,
                    websearch_to_tsquery('english', $2)) DESC, t.talk_id) AS position
            FROM public.conference_talks t
            WHERE $2 <> '' AND t.search_document @@ websearch_to_tsquery('english', $2)
                AND t.talk_id IN (SELECT f.talk_id FROM filtered f)
            ORDER BY ts_rank_cd(t.search_document, websearch_to_tsquery('english', $2)) DESC,
                t.talk_id LIMIT 80
        ), vector_sentences AS MATERIALIZED (
            %s
        ), vector_talks AS (
            SELECT v.talk_id, min(v.distance) AS distance FROM vector_sentences v
            GROUP BY v.talk_id
        ), semantic AS MATERIALIZED (
            SELECT v.talk_id, row_number() OVER (ORDER BY v.distance, v.talk_id) AS position
            FROM vector_talks v
        ), candidates AS (
            SELECT l.talk_id FROM lexical l UNION SELECT s.talk_id FROM semantic s
            UNION SELECT f.talk_id FROM filtered f WHERE $2 = '' AND $1 IS NULL
        )
        SELECT f.talk_id, f.title, f.speaker, f.year, f.season, f.url, f.text,
            coalesce((SELECT v.text FROM vector_sentences v WHERE v.talk_id = f.talk_id
                      ORDER BY v.distance LIMIT 1), left(f.text, 400)) AS excerpt,
            (coalesce(1.0 / (60 + l.position), 0) +
             coalesce(1.0 / (60 + s.position), 0))::double precision AS score,
            l.position IS NOT NULL AS keyword_match,
            s.position IS NOT NULL AS semantic_match,
            (SELECT count(*) FROM filtered) AS filtered_talk_count
        FROM candidates c JOIN filtered f ON f.talk_id = c.talk_id
        LEFT JOIN lexical l ON l.talk_id = c.talk_id
        LEFT JOIN semantic s ON s.talk_id = c.talk_id
        ORDER BY score DESC, f.year DESC NULLS LAST,
            CASE WHEN f.season = 'October' THEN 1 ELSE 0 END DESC, f.title, f.talk_id
        LIMIT $8
    $query$, vector_source) USING query_embedding, search_text, author_text, title_text,
                  year_from, year_to, season_text, safe_count;
END;
$$;
REVOKE ALL ON FUNCTION public.hybrid_search_talks(text, extensions.vector, integer, text, text, integer, integer, text)
    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hybrid_search_talks(text, extensions.vector, integer, text, text, integer, integer, text)
    TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
