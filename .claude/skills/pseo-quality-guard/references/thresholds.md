# Quality Thresholds Reference

## Content Thresholds

| Metric | Minimum | Target | Critical Failure |
|--------|---------|--------|-----------------|
| Unique word count per page | 300 | 500+ | < 150 |
| Content similarity between any 2 pages | - | < 40% | > 80% |
| Template variable ratio (variables / total words) | - | < 10% | > 50% |
| FAQ questions per page (if FAQ type) | 3 | 5-8 | 0 |

## Metadata Thresholds

| Field | Min Length | Target Length | Max Length |
|-------|-----------|---------------|-----------|
| Title | 30 chars | 50-60 chars | 70 chars |
| Meta description | 100 chars | 150-160 chars | 170 chars |
| H1 | 10 chars | 20-60 chars | 80 chars |

## Uniqueness Requirements

| Element | Tolerance | Action on Failure |
|---------|-----------|-------------------|
| Title | 100% unique | Block deploy |
| Meta description | 100% unique | Block deploy |
| H1 | 100% unique | Block deploy |
| Body content | < 80% similarity | Warning at 60%, block at 80% |
| Canonical URL | 100% unique per page | Block deploy |

## Internal Linking Thresholds

| Metric | Minimum | Target |
|--------|---------|--------|
| Inbound links per page | 2 | 5+ |
| Max crawl depth from homepage | - | 3 |
| Related pages per page | 3 | 5-6 |
| Hub pages linking to children | 100% | 100% |

## Performance Thresholds

| Metric | Good | Needs Improvement | Poor |
|--------|------|-------------------|------|
| LCP (mobile) | < 2.5s | 2.5-4.0s | > 4.0s |
| CLS | < 0.1 | 0.1-0.25 | > 0.25 |
| INP | < 200ms | 200-500ms | > 500ms |
| JS bundle per page | < 100KB | 100-200KB | > 200KB |
| Build time per 100 pages | < 30s | 30-120s | > 120s |

## Scaled Content Abuse Thresholds (Google 2025)

| Metric | Safe | Warning | Critical |
|--------|------|---------|----------|
| Template boilerplate ratio | < 60% | 60-80% | > 80% |
| Variable-swap-only pages | 0 | 1-5% of pages | > 5% of pages |
| Pages with filler intros | 0 | 1-10% | > 10% |
| Value visible in first 200 words | 100% | 90-99% | < 90% |
| Pages with zero E-E-A-T signals | 0% | 1-20% | > 20% |
| Pages published in single day | < 100 | 100-500 | > 500 |

## Content Pruning Decision Thresholds

| Condition | Action |
|-----------|--------|
| Unique words < 150 | Remove page |
| Similarity > 80% with another page | Remove weaker page, 301 redirect |
| No unique value beyond variable swaps | Remove or enrich |
| Zero search demand for target keyword | Remove or noindex |
| YMYL page without E-E-A-T signals | Noindex until fixed |

## Heading Hierarchy Rules

| Rule | Severity |
|------|----------|
| Exactly one `<h1>` per page | Critical |
| No heading level skips (e.g., h1 → h3) | Warning |
| Headings follow logical outline order | Warning |
| No empty heading tags | Critical |
| Heading content is meaningful (not "Section 1") | Info |

## Similarity Calculation

### Jaccard Similarity (for duplicate detection)

```
1. Tokenize each page's content into 3-grams (trigrams)
2. For each pair of pages:
   similarity = |intersection(A, B)| / |union(A, B)|
3. Flag pairs where similarity > 0.8
```

### Title Similarity (for cannibalization)

```
1. Normalize titles: lowercase, remove stopwords, stem remaining words
2. For each pair:
   overlap = |shared_stems| / |total_unique_stems|
3. Flag pairs where overlap > 0.7
```

## Severity Levels

- **Critical**: Blocks deployment. Must fix before launch.
  - Duplicate titles or descriptions
  - Pages with < 150 words
  - Missing canonical URLs
  - Broken internal links

- **Warning**: Should fix before launch, but not blocking.
  - Near-duplicate content (60-80% similarity)
  - Titles outside target length range
  - Pages with < 3 inbound links
  - Missing schema markup

- **Info**: Best practice recommendations.
  - Titles could be more descriptive
  - FAQ sections could have more questions
  - Cross-category linking opportunities
