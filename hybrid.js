(function (root) {
    'use strict';

    function normalize(text) {
        return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    }

    function escapeRegex(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    // Parse common metadata requests without another model call. Explicit
    // operators are also available when a natural-language request is ambiguous.
    function parseQuery(raw, speakers = []) {
        const filters = {};
        let query = raw.replace(/(?:^|\s)(author|speaker|title|year|season):(?:"([^"]*)"|'([^']*)'|(\S+))/gi,
            (_, field, quoted, singleQuoted, word) => {
                field = field.toLowerCase() === 'speaker' ? 'author' : field.toLowerCase();
                const value = (quoted ?? singleQuoted ?? word).trim();
                if (!value || /^["']/.test(value)) throw new Error('Put multiword filters inside matching quotes.');
                if (filters[field] != null) throw new Error(`Use the ${field} filter once.`);
                filters[field] = value;
                return ' ';
            });
        if (/(?:^|\s)(author|speaker|title|year|season):/i.test(query)) {
            throw new Error('Each search filter needs a value.');
        }
        if (filters.year) {
            const range = filters.year.match(/^(\d{4})(?:[-–](\d{4}))?$/);
            if (!range) throw new Error('Use year:2024 or year:2022-2024.');
            filters.year_from = Number(range[1]);
            filters.year_to = Number(range[2] || range[1]);
            delete filters.year;
        } else {
            const date = query.match(/\b((?:19|20)\d{2})(?:\s*(?:-|–|to|through)\s*((?:19|20)\d{2}))?\b/i);
            if (date) {
                filters.year_from = Number(date[1]);
                filters.year_to = Number(date[2] || date[1]);
                query = query.replace(date[0], ' ');
            }
        }
        if (!filters.season) {
            const season = query.match(/\b(April|October)\b/i);
            if (season) { filters.season = season[1]; query = query.replace(season[0], ' '); }
        }
        if (filters.season) {
            const season = filters.season.toLowerCase();
            if (!['april', 'october'].includes(season)) throw new Error('Conference must be April or October.');
            filters.season = season[0].toUpperCase() + season.slice(1);
        }

        if (!filters.author && !/\b(?:who|which)\b.*\b(?:quot\w*|mention\w*)\b/i.test(query)) {
            const aliases = new Set();
            const lastNames = new Set();
            for (const speaker of speakers) {
                const full = normalize(speaker.replace(/^By\s+/i, ''));
                const name = full.replace(/^(president|elder|brother|sister)\s+/, '');
                const words = name.split(' ');
                if (words.length < 2) continue;
                const last = words.at(-1);
                lastNames.add(last);
                aliases.add(full);
                aliases.add(name);
                aliases.add(words[0] + ' ' + last);
                const honorific = full.match(/^(president|elder|brother|sister)\b/);
                if (honorific) aliases.add(honorific[1] + ' ' + last);
            }
            for (const alias of [...aliases].sort((a, b) => b.length - a.length)) {
                const pattern = new RegExp('\\b' + alias.split(' ').map(escapeRegex).join('[\\s.\\u00a0]+') + '\\b', 'i');
                const match = query.match(pattern);
                if (match) {
                    filters.author = match[0].replace(/\./g, ' ');
                    query = query.replace(match[0], ' ');
                    break;
                }
            }
            if (!filters.author) {
                for (const name of lastNames) {
                    const pattern = new RegExp('(?:\\b(?:by|from)\\s+(' + escapeRegex(name) + ')\\b)|(?:^(' +
                        escapeRegex(name) + ')\\b)|(?:\\b(' + escapeRegex(name) + ')\\s+(?=talks?\\b))', 'i');
                    const match = query.match(pattern);
                    if (match) {
                        filters.author = match[1] || match[2] || match[3];
                        query = query.replace(match[0], ' ');
                        break;
                    }
                }
            }
        }
        if (filters.year_from > filters.year_to) throw new Error('Start year must not follow end year.');
        return { query: query.replace(/\s+/g, ' ').trim(), filters };
    }

    function sourceContext(talks) {
        // Leave room for metadata, JSON encoding, and multibyte text inside
        // the Edge Function's byte limit. Each source gets an equal allowance.
        const limit = Math.min(30_000, Math.floor(125_000 / Math.max(1, talks.length)));
        return talks.map(talk => ({
            title: talk.title, speaker: talk.speaker || 'Unknown speaker',
            year: talk.year, season: talk.season, text: talk.text.slice(0, limit),
        }));
    }

    const api = { parseQuery, sourceContext };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof document === 'undefined') return;

    const form = document.getElementById('hybrid-form');
    if (!form) return;
    const field = name => document.getElementById('hybrid-' + name);
    let catalog = [];
    let epoch = 0;
    let initializing = false;
    let initialized = false;

    api.initialize = async function () {
        if (initialized || initializing || !supabaseClient) return;
        initializing = true;
        const current = epoch;
        try {
            const { data, error } = await supabaseClient.from('conference_talks')
                .select('speaker,year').order('year', { ascending: false }).limit(1000);
            if (current !== epoch) return;
            if (error || !data?.length) { setSearchReady('hybrid', false); return; }
            catalog = data;
            const authors = [...new Set(data.map(t => t.speaker).filter(Boolean))].sort();
            field('authors').replaceChildren(...authors.map(author => {
                const option = document.createElement('option'); option.value = author; return option;
            }));
            for (const id of ['year-from', 'year-to']) {
                const select = field(id);
                select.replaceChildren(new Option('Any year', ''),
                    ...[...new Set(data.map(t => t.year).filter(Boolean))].sort((a, b) => b - a)
                        .map(year => new Option(year, year)));
            }
            initialized = true;
            setSearchReady('hybrid', true);
        } finally { initializing = false; }
    };

    api.reset = function () {
        epoch++;
        catalog = [];
        initialized = false;
        form.reset();
        field('applied').textContent = '';
        field('results').replaceChildren();
        setSearchReady('hybrid', false);
    };

    function renderSources(talks) {
        return talks.map((talk, i) => {
            const signal = talk.keyword_match && talk.semantic_match ? 'Keywords + meaning'
                : talk.keyword_match ? 'Keywords' : talk.semantic_match ? 'Meaning' : 'Metadata';
            // All displayed text is escaped, including externally scraped text.
            const url = /^https:\/\/www\.churchofjesuschrist\.org\//.test(talk.url || '') ? talk.url : '#';
            return `<article class="result-card result-source">
                <div class="result-card-header"><div>
                    <div class="result-title"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">[${i + 1}] ${escapeHtml(talk.title)}</a></div>
                    <div class="result-speaker">${escapeHtml(talk.speaker || 'Unknown speaker')}</div>
                    <div class="hybrid-date">${escapeHtml(`${talk.season || ''} ${talk.year || ''}`.trim())}</div>
                </div><span class="hybrid-signal">${signal}</span></div>
                <p class="hybrid-excerpt">${escapeHtml((talk.excerpt || '').slice(0, 600))}</p>
            </article>`;
        }).join('');
    }

    form.addEventListener('submit', async event => {
        event.preventDefault();
        if (!supabaseClient || field('btn').disabled) return;
        const current = ++epoch;
        field('btn').disabled = true;
        field('results').replaceChildren();
        field('applied').textContent = '';
        showLoading(true);
        try {
            const raw = field('input').value.trim();
            const parsed = parseQuery(raw, catalog.map(t => t.speaker).filter(Boolean));
            const filters = {
                ...parsed.filters,
                author: field('author').value.trim() || parsed.filters.author || speakerSelect?.value || null,
                title: field('title').value.trim() || parsed.filters.title || null,
                year_from: Number(field('year-from').value) || parsed.filters.year_from || null,
                year_to: Number(field('year-to').value) || parsed.filters.year_to || null,
                season: field('season').value || parsed.filters.season || null,
            };
            if (filters.year_from && filters.year_to && filters.year_from > filters.year_to) {
                throw new Error('Start year must not follow end year.');
            }
            const labels = [filters.author && `Author: ${filters.author}`, filters.title && `Title: ${filters.title}`,
                filters.year_from && `From: ${filters.year_from}`, filters.year_to && `Through: ${filters.year_to}`,
                filters.season && `Conference: ${filters.season}`].filter(Boolean);
            field('applied').textContent = labels.length ? labels.join(' · ') : 'Searching all authors and conference dates.';
            let embedding = null;
            let fallback = '';
            if (parsed.query) {
                try { embedding = await getEmbedding(parsed.query); }
                catch { fallback = 'Meaning search is unavailable. Showing keyword matches.'; }
            }
            if (current !== epoch) return;
            const { data: talks, error } = await supabaseClient.rpc('hybrid_search_talks', {
                query_text: parsed.query, query_embedding: embedding, match_count: 8,
                filter_author: filters.author, filter_title: filters.title,
                year_from: filters.year_from, year_to: filters.year_to, filter_season: filters.season,
            });
            if (error) throw new Error(error.message);
            if (current !== epoch) return;
            if (!talks?.length) {
                showResults('hybrid', `<div class="no-results">No talks matched. Try a broader author, title, or date filter.${fallback ? ' ' + escapeHtml(fallback) : ''}</div>`);
                return;
            }
            const sources = renderSources(talks);
            const coverage = `<p class="hybrid-coverage">${talks.length} ranked source${talks.length === 1 ? '' : 's'} shown from ${talks[0].filtered_talk_count} talks within your author, title, and date filters. Answers cover the shown sources.</p>`;
            showResults('hybrid', coverage + (fallback ? `<p class="hybrid-coverage">${escapeHtml(fallback)}</p>` : '') + sources);
            if (field('answer').checked && parsed.query && !fallback) {
                const contexts = sourceContext(talks);
                try {
                    const answer = await generateAnswer(raw, contexts);
                    if (current !== epoch) return;
                    const shortened = contexts.some((t, i) => t.text.length < talks[i].text.length)
                        ? '<p class="hybrid-coverage">Long sources were shortened to fit the answer context.</p>' : '';
                    showResults('hybrid', `<div class="result-card rag-answer"><div class="result-title">AI Answer</div><div class="result-sentences">${escapeHtml(answer)}</div></div>` + coverage + shortened + sources);
                } catch (error) {
                    if (current === epoch) showResults('hybrid', `<div class="result-error">Answer unavailable: ${escapeHtml(error.message)}</div>` + coverage + sources);
                }
            }
        } catch (error) {
            if (current === epoch) showResults('hybrid', `<div class="result-error">${escapeHtml(error.message)}</div>`);
        } finally {
            if (current === epoch) { field('btn').disabled = false; showLoading(false); }
            else if (document.getElementById('app-screen').classList.contains('hidden')) showLoading(false);
        }
    });

    field('reset').addEventListener('click', () => {
        for (const id of ['author', 'title', 'year-from', 'year-to', 'season']) field(id).value = '';
        field('applied').textContent = '';
        field('input').value = '';
        if (speakerSelect) speakerSelect.value = '';
    });
    document.querySelectorAll('.hybrid-example').forEach(button => button.addEventListener('click', () => {
        field('reset').click();
        field('input').value = button.dataset.query;
        field('input').focus();
    }));
    root.ConferenceHybrid = api;
    if (!document.getElementById('app-screen').classList.contains('hidden')) api.initialize();
})(globalThis);
