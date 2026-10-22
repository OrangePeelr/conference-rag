"""Check deployed RLS, auth, and quotas; --rag also exercises paid AI calls.

Creates an isolated test account without sending email and deletes it in finally.
Run from the repository root: python scripts/verify_security.py [--rag]
"""
import json
import math
import sys
import uuid
from pathlib import Path

import requests


def main():
    public = json.loads(Path('config.public.json').read_text())
    secret = json.loads(Path('config.secret.json').read_text())
    base = public['SUPABASE_URL']
    anon = {'apikey': public['SUPABASE_ANON_KEY'], 'Authorization': 'Bearer ' + public['SUPABASE_ANON_KEY']}
    admin = {'apikey': secret['SUPABASE_SERVICE_KEY'], 'Authorization': 'Bearer ' + secret['SUPABASE_SERVICE_KEY']}
    session = requests.Session()
    user_id = None
    checks = []

    def request(method, path, headers, **kwargs):
        return session.request(method, base + path, headers=headers, timeout=90, **kwargs)

    def check(name, condition):
        if not condition:
            raise AssertionError(name)
        checks.append(name)
        print('PASS:', name, flush=True)

    try:
        password = uuid.uuid4().hex + uuid.uuid4().hex
        email = f'rag-verification-{uuid.uuid4().hex}@example.com'
        response = request('POST', '/auth/v1/admin/users', admin,
                           json={'email': email, 'password': password, 'email_confirm': True})
        check('Create isolated test account without email', response.ok)
        user_id = response.json()['id']
        response = request('POST', '/auth/v1/token?grant_type=password', anon,
                           json={'email': email, 'password': password})
        check('Authenticate test account', response.ok)
        headers = {**anon, 'Authorization': 'Bearer ' + response.json()['access_token']}

        response = request('GET', '/rest/v1/sentence_embeddings?select=id&limit=1', anon)
        check('Anonymous reads return no protected sentences', response.ok and response.json() == [])
        response = request('GET', '/rest/v1/page_views?select=id&limit=1', anon)
        check('Anonymous public analytics reads are allowed', response.ok)
        response = request('GET', '/rest/v1/sentence_embeddings?select=id,title&limit=1', headers)
        check('Authenticated user can read imported talks', response.ok and len(response.json()) == 1)
        row_id = response.json()[0]['id']
        payload = {'talk_id': str(uuid.uuid4()), 'title': 'Unauthorized write', 'text': 'Must be rejected.'}
        for name, role in [('anonymous', anon), ('authenticated', headers)]:
            response = request('POST', '/rest/v1/sentence_embeddings', role, json=payload)
            check(f'{name} cannot insert corpus data', response.status_code in (401, 403))
        response = request('PATCH', f'/rest/v1/sentence_embeddings?id=eq.{row_id}', headers,
                           json={'title': 'Unauthorized change'})
        check('Authenticated user cannot update corpus data', response.status_code in (401, 403))
        response = request('POST', '/rest/v1/rpc/list_speakers', anon, json={})
        check('Anonymous caller cannot enumerate speakers', response.status_code in (401, 403))
        response = request('POST', '/rest/v1/rpc/list_speakers', headers, json={})
        check('Authenticated speaker filter has choices', response.ok and len(response.json()) > 1)
        speaker = response.json()[0]['speaker']
        for function in ['embed-question', 'generate-answer']:
            path = '/functions/v1/' + function
            response = request('POST', path, anon, json={'healthcheck': True})
            check(f'{function} rejects anonymous requests', response.status_code == 401)
            response = request('POST', path, {**anon, 'Authorization': 'Bearer fake-token'}, json={'healthcheck': True})
            check(f'{function} rejects forged tokens', response.status_code == 401)
            response = request('POST', path, headers, json={'healthcheck': True})
            check(f'{function} authenticated health check', response.ok and response.json().get('ready') is True)
            response = request('POST', path, {**headers, 'Origin': 'https://untrusted.example'}, json={'healthcheck': True})
            check(f'{function} rejects unapproved browser origins', response.status_code == 403)
        response = request('POST', '/functions/v1/embed-question', {**headers, 'Content-Type': 'application/json'}, data='{')
        check('Malformed JSON is rejected before AI calls', response.status_code == 400)
        response = request('POST', '/functions/v1/embed-question', headers, json={'question': 'x' * 2001})
        check('Oversized questions are rejected', response.status_code == 400)
        response = request('POST', '/functions/v1/generate-answer', headers, json={'question': 'Faith?', 'context_talks': []})
        check('Missing RAG context is rejected', response.status_code == 400)

        consumed = 0
        if '--rag' in sys.argv:
            question = 'How can I find peace during difficult times?'
            response = request('POST', '/functions/v1/embed-question', headers, json={'question': question})
            check('Question embedding succeeds', response.ok)
            embedding = response.json()['embedding']
            consumed += 1
            check('Embedding has 1536 finite dimensions', len(embedding) == 1536 and all(math.isfinite(x) for x in embedding))
            response = request('POST', '/rest/v1/rpc/match_sentences', headers,
                               json={'query_embedding': embedding, 'match_count': 20})
            check('Vector search returns cited sources', response.ok and bool(response.json()) and all(r.get('url') for r in response.json()))
            matches = response.json()
            response = request('POST', '/rest/v1/rpc/match_sentences', headers,
                               json={'query_embedding': embedding, 'match_count': 20, 'filter_speaker': speaker})
            check('Vector search enforces speaker filter and returns results', response.ok and bool(response.json()) and all(r['speaker'] == speaker for r in response.json()))
            response = request('POST', '/rest/v1/rpc/match_sentences', anon,
                               json={'query_embedding': embedding, 'match_count': 20})
            check('Anonymous caller cannot run vector search', response.status_code in (401, 403))
            talks = []
            for match in matches:
                if any(t['title'] == match['title'] for t in talks):
                    continue
                response = request('GET', f"/rest/v1/sentence_embeddings?talk_id=eq.{match['talk_id']}&select=text&order=sentence_num", headers)
                check('Retrieve full talk context', response.ok)
                talks.append({'title': match['title'], 'speaker': match['speaker'],
                              'text': ' '.join(r['text'] for r in response.json())})
                if len(talks) == 3:
                    break
            response = request('POST', '/functions/v1/generate-answer', headers,
                               json={'question': question, 'context_talks': talks})
            consumed += 1
            check('RAG returns an answer with numbered citations', response.ok and any(f'[{i}]' in response.json().get('answer', '') for i in range(1, 4)))
            Path('scripts/output/verified-answer.json').write_text(json.dumps({'question': question, 'answer': response.json()['answer'], 'sources': [t['title'] for t in talks]}, indent=2))

        for _ in range(20 - consumed):
            response = request('POST', '/rest/v1/rpc/consume_ai_quota', headers, json={})
            assert response.ok and response.json() is True, 'Quota rejected requests too early'
        response = request('POST', '/rest/v1/rpc/consume_ai_quota', headers, json={})
        check('Database quota blocks the 21st AI request', response.ok and response.json() is False)
        response = request('POST', '/functions/v1/embed-question', headers, json={'question': 'Over quota'})
        check('Edge Function returns 429 before upstream AI call', response.status_code == 429)
        Path('scripts/output/security-check.json').write_text(json.dumps({'checks': checks, 'rag_tested': '--rag' in sys.argv}, indent=2))
    finally:
        if user_id:
            response = request('DELETE', '/auth/v1/admin/users/' + user_id, admin)
            if not response.ok:
                raise RuntimeError('Could not remove test account ' + user_id)
            print('Removed isolated test account.', flush=True)


if __name__ == '__main__':
    main()
