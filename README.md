# Conference RAG

A Retrieval Augmented Generation (RAG) application that lets users ask questions about General Conference talks using semantic search and AI-generated answers.

<p align="center">
  <img src="example.png" alt="Conference RAG screenshot" width="600">
  <br>
  <em>Sample screenshot — semantic search with AI-generated answers</em>
</p>

## This deployment

- App: https://orangepeelr.github.io/conference-rag/
- Fork: https://github.com/OrangePeelr/conference-rag
- Supabase project: `rlrnrrgffadpbhcpopzc`
- Custom feature: a speaker selector shared by keyword search, semantic search, and RAG. The speaker restriction is applied in the database before selecting sources.
- A fourth panel, **Combined Search & Answers**, appears below RAG. It combines weighted full-text search over title, speaker, calling, conference date, and talk text with the existing sentence-vector search. Both searches apply author/title/year/season restrictions before reciprocal rank fusion (RRF), with one result per talk. Keyword and semantic ranks contribute `1 / (60 + rank)` each; fused scores are not confidence percentages.
- AI provider: OpenRouter, using `openai/text-embedding-3-small` (1,536 dimensions) and `openai/gpt-4o`. The models match the assignment; requests go through OpenRouter's OpenAI-compatible API.

### Run and maintain this version

Run commands from this repository directory. Use Python 3.13 and install `requirements.txt` in a virtual environment. Public browser configuration lives in `config.public.json`. Private scripts use the git-ignored `config.secret.json`; for this deployment its AI credential is `OPENROUTER_API_KEY`. Never add the root `.env` or secret config to Git.

Run `scripts/01_create_schema.py`, then the numbered data scripts in order. The scraper uses the latest five calendar years. Stable sentence IDs let imports resume without deleting the corpus. The embedding script saves progress and checks that cached records still match its input.

The hybrid migration backfills `conference_talks` from existing sentences without changing embeddings. Future imports upsert the talk-level documents as well as sentences. Its weighted `tsvector` has a GIN index; RLS permits signed-in reads and service-role writes. Exact conference days are not in the corpus: date filters mean year and April/October conference.

In the fourth panel, use the filter controls, ask a question such as `What did President Nelson teach about temples in 2024?`, or use `author:"President Nelson" year:2024 temple` and `title:"Think Celestial"`. A deterministic parser recognizes common author/date mentions, with the applied restrictions displayed above results. A last name can match more than one author: `Nelson` includes Michael T. Nelson; `President Nelson` narrows to Russell M. Nelson. Questions asking who quoted an author are not automatically restricted to that author. Form filters override detected filters; the shared speaker selector is the fallback when no author is specified.

Up to eight ranked talks are supplied to the answer model, with numbered citations, author/date metadata, and explicit context limits. Results remain visible if embedding or answer generation fails. Metadata-only browsing needs no AI call; ordinary search uses an embedding call, and the optional answer uses another call. Answers cover the selected sources and cannot establish topic frequency across the complete corpus.

The SQL migration creates authenticated read access to the conference corpus, service-role write access, a cosine HNSW index, speaker filtering, and an atomic quota of 20 AI requests per user per minute. Each full RAG question uses two requests: embedding and answer generation. `page_views` deliberately remains public for the assignment's RLS exercise. Health checks require login and do not call a paid model.

Retrieval uses separate SQL branches for all speakers and a selected speaker, with `EXECUTE ... USING` to plan for the actual parameters while keeping data bound safely. During verification, the original optional-filter generic plan performed a full scan and timed out; the corrected query uses the vector index. Iterative HNSW scanning keeps selective speaker filters useful. See [PostgreSQL dynamic commands](https://www.postgresql.org/docs/current/plpgsql-statements.html#PLPGSQL-STATEMENTS-EXECUTING-DYN) and [Supabase HNSW filtering](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes).

Edge Functions validate the user's token against Supabase Auth, enforce the quota, validate request sizes, and then call the AI provider with server-side secrets. `verify_jwt = false` in the CLI configuration means validation happens inside each function; it does not make them anonymous. Deploy functions with the Supabase CLI using `--project-ref rlrnrrgffadpbhcpopzc --use-api` after setting `SUPABASE_ACCESS_TOKEN` in the environment and storing `OPENROUTER_API_KEY` with Supabase secrets. GitHub Actions deploys an explicit list of public website assets on pushes to `main`.

Verify the deployed security behavior with:

```bash
python scripts/verify_security.py
python scripts/verify_security.py --rag  # includes real AI calls
node --test tests/hybrid.test.cjs
python scripts/verify_hybrid.py
python scripts/verify_hybrid.py --rag    # includes embedding and eight-source answer
```

These checks create and remove an isolated test account without sending email. The second command additionally checks vector retrieval, speaker filtering, and an answer with citations. Test results and the generated answer are saved in the ignored `scripts/output/` directory. Automated checks do not replace trying magic-link delivery in your own inbox.

This is a working class-project deployment, not evidence of capacity for millions of users. The vector index, stateless functions, and database-enforced access controls provide a starting point; production scale would require load tests, capacity planning, global abuse controls, and operational monitoring.

## 🚀 Quick Start

Follow the step-by-step guides in the `steps/` folder:

```
🏁 LAUNCH ──→ 🔐 SIGN IN ──→ 🔍 KEYWORD ──→ 🧠 SEMANTIC ──→ 🤖 RAG ──→ 🚀 YOURS
```

| Step | Milestone | Topic | Time |
|------|-----------|-------|------|
| [00](steps/00_overview.md) | — | Overview & Environment Setup | 15 min |
| [01](steps/01_fork_and_deploy.md) | 🏁 Launch | Fork & Deploy to GitHub Pages | 15 min |
| [02](steps/02_supabase_and_login.md) | 🔐 Sign In | Supabase Project & Login | 15 min |
| [03](steps/03_database_schema.md) | 🔍 Keyword (1/2) | Database Schema & RLS | 10 min |
| [04](steps/04_scrape_and_import.md) | 🔍 Keyword (2/2) | Scrape & Import → First green light! | 20 min |
| [05](steps/05_embeddings.md) | 🧠 Semantic | Embeddings & Edge Function | 25 min |
| [06](steps/06_rag.md) | 🤖 RAG | RAG Edge Function → All green! | 15 min |
| [07](steps/07_make_it_yours.md) | 🚀 Yours | Add Feature & Reflection | 20 min |

**Prerequisites:**
- [Supabase](https://supabase.com) account (free tier)
- [GitHub](https://github.com) account
- [OpenAI API key](https://platform.openai.com/api-keys) (~$0.60 usage)
- Python 3.9+
- An AI coding assistant (Antigravity, GitHub Copilot, or Cursor)

## 🤖 AI-Assisted Development

This assignment is designed to be completed with an AI coding assistant. See [Step 00](steps/00_overview.md) for setup instructions.

Your AI assistant will automatically read [`ai_agent_instructions.md`](ai_agent_instructions.md) to understand the assignment's learning objectives and teach you along the way.

## 🏗️ Architecture

```
┌─────────────┐
│   Browser   │  Student asks question
│  (GitHub    │
│   Pages)    │
└──────┬──────┘
       │
       ├─── Supabase Auth (magic link)
       │
       ├─── Edge Function: embed-question
       │         ↓ OpenAI API (server-side 🔒)
       │         ↓ Returns embedding vector
       │
       ├─── Supabase Database (pgvector)
       │         ↓ match_sentences()
       │         ↓ Returns similar sentences
       │
       └─── Edge Function: generate-answer
                ↓ GPT-4o (server-side 🔒)
                ↓ Returns final answer
```

## 🔍 Three Search Modes

| Mode | What it does | Requires |
|------|-------------|----------|
| **🔍 Keyword Search** | SQL `ILIKE` query on talk text | Conference data imported |
| **🧠 Semantic Search** | Vector similarity with pgvector | Embeddings + `embed-question` Edge Function |
| **🤖 Ask a Question (RAG)** | AI-generated answers with sources | All Edge Functions deployed |

## 📁 Project Structure

```
conference-rag/
├── index.html                  # Main application UI
├── app.js                      # Three search modes + auth logic
├── styles.css                  # Dark theme styling
├── config.js                   # Loads config.public.json for browser
├── config.public.json          # Supabase URL + anon key (safe to commit)
├── config.secret.json          # API keys & secrets (git-ignored, YOU create this)
├── config.secret.example.json  # Template for config.secret.json
├── requirements.txt            # Python dependencies
├── .nojekyll                   # Tells GitHub Pages not to use Jekyll
├── steps/                      # Step-by-step assignment guides
│   ├── 00_overview.md
│   ├── ...
│   └── 07_make_it_yours.md
├── scripts/                    # Pipeline scripts (run in order)
│   ├── 01_create_schema.py     # Create DB schema
│   ├── 02_scrape_data.py       # Scrape conference talks → scripts/output/talks.json
│   ├── 03_import_data.py       # Import text to Supabase (🔍 keyword!)
│   ├── 04_embed_data.py        # Generate embeddings → scripts/output/ (💰 saved to disk!)
│   ├── 05_update_embeddings.py # Update DB with embeddings (🧠 semantic!)
│   └── output/                 # Intermediate data files (git-ignored)
└── supabase/                   # Edge Functions (YOU create this with supabase init)
    └── functions/
        ├── _shared/            # Shared auth & CORS helpers
        ├── embed-question/     # Converts questions to embeddings
        └── generate-answer/    # Generates AI answers
```

## 🔒 Security Model

| Component | Security Approach |
|-----------|------------------|
| Supabase anon key | Safe to expose in `config.public.json` (protected by RLS) |
| OpenAI API key | Server-side only via Edge Functions (in `config.secret.json`) |
| Database access | Row Level Security policies |
| Transport | HTTPS enforced by GitHub Pages |

## 📚 Learning Objectives

1. **Vector Embeddings** — Representing text as searchable numbers
2. **Semantic Search** — Finding similar content with cosine similarity
3. **RAG Architecture** — Combining retrieval + generation
4. **Edge Functions** — Serverless compute for secure API management
5. **Row Level Security** — User-level data access control
6. **Production Deployment** — Full-stack app on GitHub Pages

## 🎓 Assignment Deliverables

1. GitHub repository URL (your fork)
2. Live deployment URL (GitHub Pages)
3. Screenshot of a working query + answer
4. Your custom feature description
5. Written reflection on security, search, and AI-assisted development

## 🆘 Troubleshooting

| Issue | Solution |
|-------|----------|
| "Please configure Supabase" | Update `config.public.json` with your project URL and anon key |
| Magic link not working | Add your site URL to Supabase → Authentication → URL Configuration |
| Magic link email not arriving | Free tier allows only **3 per hour** — wait and try again, check spam |
| Changes don't appear | Hard refresh (Ctrl+Shift+R) or try incognito window |
| Search shows "Not Ready" | Complete the corresponding step first |
| "Failed to get embedding" | Deploy Edge Functions and set OPENAI_API_KEY secret |
| "Database search failed" | Run `scripts/01_create_schema.py` |
| No search results | Import data with `scripts/03_import_data.py` |

## 📄 License

Educational use only. Conference talk content is used under fair use for educational purposes.

---

Built with ❤️ for CS 452
