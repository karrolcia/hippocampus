# AI Crawler Reference

## Known AI Crawlers (as of January 2026)

### Retrieval Crawlers (needed for citation — ALLOW)

| Crawler | User-Agent | Platform | Purpose |
|---------|-----------|----------|---------|
| GPTBot | `GPTBot` | OpenAI / ChatGPT | Fetches pages for ChatGPT web search |
| ChatGPT-User | `ChatGPT-User` | OpenAI / ChatGPT | User-initiated browsing in ChatGPT |
| PerplexityBot | `PerplexityBot` | Perplexity | Fetches pages for Perplexity answers |
| ClaudeBot | `ClaudeBot` | Anthropic / Claude | Fetches pages for Claude web search |
| Bingbot | `Bingbot` | Microsoft / Bing | Powers ChatGPT and Copilot via Bing index |
| Googlebot | `Googlebot` | Google | Powers AI Overviews via Google index |
| Applebot-Extended | `Applebot-Extended` | Apple | Powers Apple Intelligence features |

### Training Crawlers (optional — may choose to BLOCK)

| Crawler | User-Agent | Platform | Purpose |
|---------|-----------|----------|---------|
| Google-Extended | `Google-Extended` | Google | Data for Gemini model training |
| CCBot | `CCBot` | Common Crawl | Open dataset used by many LLMs |
| Bytespider | `Bytespider` | ByteDance | Data for TikTok AI features |
| FacebookBot | `FacebookExternalHit` | Meta | Data for Meta AI |
| Cohere-ai | `cohere-ai` | Cohere | Data for Cohere models |

## Platform Citation Patterns

### ChatGPT
- **Source**: Bing index + GPTBot direct crawling
- **Preferred content**: Conversational, consensus-based, encyclopedic
- **Top cited domains**: Wikipedia, authoritative reference sites
- **Format preference**: Q&A, definitions, how-to steps
- **Key signal**: Being indexed by Bing is mandatory

### Google AI Overviews
- **Source**: Google index
- **Preferred content**: Traditional SEO-strong pages with direct answer formatting
- **Top cited sources**: Authoritative domains, community sites (Reddit, forums)
- **Format preference**: Featured-snippet-style concise answers
- **Key signal**: E-E-A-T and traditional SEO signals still dominant

### Perplexity
- **Source**: Own crawler + Bing index
- **Preferred content**: Academic, news, heavily-cited factual content
- **Top cited domains**: Authoritative sources, community discussion sites
- **Format preference**: Data-rich, well-sourced, comparison content
- **Key signal**: Schema markup and machine-readable structure

### Claude
- **Source**: Web search (provider varies)
- **Preferred content**: Factual, well-structured, comprehensive
- **Format preference**: Clear sections with self-contained answers
- **Key signal**: Content accessibility (SSR/SSG, not JS-rendered)

## llms.txt Format Reference

```markdown
# Site Name

> Brief description of the site and its content focus.

## Docs

- [Page Title](https://example.com/page): Brief description of what this page covers
- [Another Page](https://example.com/another): Brief description

## Optional

- [Less Important Page](https://example.com/optional): Description
```

### For pSEO sites, structure llms.txt by category:

```markdown
# Example Site - [Domain]

> [One-line description of the site's purpose and expertise]

## Categories

- [Category A](/category-a): [What this category covers, N pages]
- [Category B](/category-b): [What this category covers, N pages]

## Page Types

- Individual pages: [What each page contains — data, FAQs, comparisons]
- Hub pages: [Category overviews with links to all pages in the category]

## Data & Freshness

- Data source: [Where the information comes from]
- Update frequency: [How often content is refreshed]
- Last full update: [Date]

## Full Index

- [/llms-full.txt](/llms-full.txt): Complete page index with descriptions
- [/sitemap.xml](/sitemap.xml): XML sitemap for all pages
```

## Content Chunk Optimization

### Optimal chunk sizes for AI extraction:

| Metric | Optimal Range | Basis |
|--------|--------------|--------|
| Words per section (between headings) | 120-180 words | Industry analysis |
| Self-contained answer length | 134-167 words | GEO research (Aggarwal et al.) |
| Token count per chunk | 100-300 tokens | LLM extraction patterns |
| FAQ answer length | 50-150 words | Rich Results + LLM citation analysis |

### Research-backed optimization methods (GEO: Generative Engine Optimization, Aggarwal et al., 2024, arXiv:2311.09735):

| Method | Visibility Improvement (GEO study) |
|--------|----------------------|
| Statistics Addition | ~+41% |
| Quotation Addition | ~+28% |
| Source Citation | ~+22% |
| Clear Structure (H2/H3/lists) | ~+40% citation likelihood |
| Comparison/list format | Large share of all AI citations |

### Freshness impact (approximate, varies by platform and topic):

| Content Age | Relative Citation Rate |
|-------------|----------------------|
| Updated within 30 days | Significantly higher |
| Updated within 90 days | Moderately higher |
| Updated 6+ months ago | Below average |
| Stale (1+ year, no update) | Substantially lower |

Freshness is one of the strongest signals for AI citation. Exact multipliers vary by AI platform, topic domain, and query type. The directional trend is consistent: fresher content gets cited more.
