"""Verify hybrid retrieval, metadata restrictions, RLS, and optional AI answer.

Run from the repository root: python scripts/verify_hybrid.py [--rag]
Creates and removes an isolated test account without sending email.
"""
import json
import sys
import time
import uuid
from pathlib import Path

import requests


def main():
    public = json.loads(Path('config.public.json').read_text())
    secret = json.loads(Path('config.secret.json').read_text())
    base = public['SUPABASE_URL']
    anon = {'apikey': public['SUPABASE_ANON_KEY'], 'Authorization': 'Bearer ' + public['SUPABASE_ANON_KEY']}
    admin = {'apikey': secret['SUPABASE_SERVICE_KEY'], 'Authorization': 'Bearer ' + secret['SUPABASE_SERVICE_KEY']}
    user_id = None
    checks = []

    def request(method, path, headers, **kwargs):
        return requests.request(method, base + path, headers=headers, timeout=90, **kwargs)

    def check(label, success):
        assert success, label
        checks.append(label)
        print('PASS:', label, flush=True)

    try:
        password = uuid.uuid4().hex + uuid.uuid4().hex
        email = f'hybrid-check-{uuid.uuid4().hex}@example.com'
        response = request('POST', '/auth/v1/admin/users', admin,
                           json={'email': email, 'password': password, 'email_confirm': True})
        response.raise_for_status()
        user_id = response.json()['id']
        response = request('POST', '/auth/v1/token?grant_type=password', anon,
                           json={'email': email, 'password': password})
        response.raise_for_status()
        headers = {**anon, 'Authorization': 'Bearer ' + response.json()['access_token']}

        def search(**kwargs):
            start = time.monotonic()
            response = request('POST', '/rest/v1/rpc/hybrid_search_talks', headers, json=kwargs)
            if not response.ok:
                raise RuntimeError(f'Hybrid query failed: {response.status_code} {response.text[:300]}')
            print(f'  Query returned {len(response.json())} talks in {time.monotonic() - start:.2f}s', flush=True)
            return response.json()

        response = request('GET', '/rest/v1/conference_talks?select=talk_id&limit=1', anon)
        check('Anonymous reads expose no indexed talks', response.ok and response.json() == [])
        response = request('POST', '/rest/v1/rpc/hybrid_search_talks', anon, json={})
        check('Anonymous caller cannot execute hybrid search', response.status_code in (401, 403))
        response = request('POST', '/rest/v1/conference_talks', headers,
                           json={'talk_id': str(uuid.uuid4()), 'title': 'Unauthorized', 'text': 'Rejected'})
        check('Authenticated caller cannot modify search index', response.status_code in (401, 403))

        talks = search(filter_author='President Nelson')
        check('President Nelson author lookup finds the 12 imported talks',
              len(talks) == 8 and all('Russell' in t['speaker'] for t in talks)
              and all(t['filtered_talk_count'] == 12 for t in talks))
        talks = search(filter_author='Nelson')
        check('Surname filter does not accidentally match Denelson Silva',
              bool(talks) and all('Denelson' not in t['speaker'] for t in talks)
              and talks[0]['filtered_talk_count'] == 13)
        talks = search(filter_author='President Nelson', year_from=2024, year_to=2024, filter_season='April')
        check('Author, year, and conference season combine as strict restrictions',
              len(talks) == 1 and talks[0]['title'] == 'Rejoice in the Gift of Priesthood Keys')
        talks = search(filter_title='Think Celestial', year_from=2023, year_to=2023)
        check('Title and year lookup finds the actual talk', len(talks) == 1 and 'Russell' in talks[0]['speaker'])
        talks = search(query_text='Think Celestial')
        check('Weighted keyword search ranks a matching title first', bool(talks) and talks[0]['title'] == 'Think Celestial!')
        talks = search(query_text='Russell Nelson')
        check('Keyword search includes author metadata', bool(talks) and all('Russell' in t['speaker'] for t in talks[:3]))
        check('Impossible metadata filters return no sources', search(filter_author='President Nelson', year_from=1900, year_to=1900) == [])
        check('Metadata filters remain bound data rather than SQL', search(filter_author="Nelson' OR true --") == [])
        response = request('POST', '/rest/v1/rpc/hybrid_search_talks', headers, json={'year_from': 2025, 'year_to': 2022})
        check('Invalid date range is rejected', response.status_code == 400)

        if '--rag' in sys.argv:
            response = request('POST', '/functions/v1/embed-question', headers, json={'question': 'temple'})
            response.raise_for_status()
            embedding = response.json()['embedding']
            talks = search(query_text='temple', query_embedding=embedding,
                           filter_author='President Nelson', year_from=2024, year_to=2024)
            check('Hybrid retrieval filters semantic and keyword candidates before fusion',
                  bool(talks) and all('Russell' in t['speaker'] and t['year'] == 2024 for t in talks))
            check('Both retrieval methods contribute to fused results',
                  any(t['keyword_match'] and t['semantic_match'] for t in talks))
            talks = search(query_text='temple', query_embedding=embedding)
            check('Unfiltered vector and keyword fusion returns eight distinct talks',
                  len(talks) == 8 and len({t['talk_id'] for t in talks}) == 8)
            check('Results include full source text, date, and link', all(t['text'] and t['year'] and t['url'] for t in talks))
            limit = min(30_000, 125_000 // len(talks))
            sources = [{k: t[k] for k in ['title', 'speaker', 'year', 'season']} | {'text': t['text'][:limit]} for t in talks]
            response = request('POST', '/functions/v1/generate-answer', headers,
                               json={'question': 'What do these sources teach about temples?', 'context_talks': sources})
            if not response.ok:
                raise RuntimeError(f'Answer failed: {response.status_code} {response.text[:300]}')
            check('Eight-source RAG answer succeeds with numbered citations',
                  any(f'[{i}]' in response.json().get('answer', '') for i in range(1, 9)))
            Path('scripts/output/hybrid-example.json').write_text(json.dumps({'answer': response.json()['answer'],
                'sources': [{k:t[k] for k in ['title','speaker','year','season','keyword_match','semantic_match']} for t in talks]}, indent=2))
        Path('scripts/output/hybrid-check.json').write_text(json.dumps({'checks': checks, 'rag_tested': '--rag' in sys.argv}, indent=2))
    finally:
        if user_id:
            response = request('DELETE', '/auth/v1/admin/users/' + user_id, admin)
            response.raise_for_status()
            print('Removed isolated hybrid test account.', flush=True)


if __name__ == '__main__':
    main()
