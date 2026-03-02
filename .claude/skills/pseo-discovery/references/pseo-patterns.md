# pSEO Patterns by Business Vertical

## E-commerce

| Page Type | URL Pattern | Data Required | Volume Potential |
|-----------|------------|---------------|-----------------|
| Product pages | `/products/[slug]` | name, description, specs, images, price, reviews | High (100-100K) |
| Category pages | `/category/[slug]` | category name, description, child products | Medium (10-500) |
| Brand pages | `/brands/[slug]` | brand name, description, products by brand | Medium (10-500) |
| Comparison pages | `/compare/[product-a]-vs-[product-b]` | 2 products with comparable attributes | High (n² combinations) |
| Use-case pages | `/best-[category]-for-[use-case]` | category, use cases, filtered product lists | Medium (categories × use cases) |
| Deal/price pages | `/deals/[category]` | products with price drops, categories | Low-Medium |

**Data signals to look for**: product catalog, category taxonomy, review data, pricing data, specification attributes.

## SaaS / Software

| Page Type | URL Pattern | Data Required | Volume Potential |
|-----------|------------|---------------|-----------------|
| Integration pages | `/integrations/[tool]` | integration name, description, features, setup steps | Medium (50-500) |
| Alternative pages | `/alternatives/[competitor]` | competitor name, comparison points, differentiators | Low-Medium (20-100) |
| VS pages | `/compare/[tool]-vs-[competitor]` | both tools' features, pricing, pros/cons | Medium (n × competitors) |
| Feature pages | `/features/[feature]` | feature name, description, use cases, screenshots | Low-Medium (20-100) |
| Use-case pages | `/solutions/[use-case]` | use case name, relevant features, testimonials | Low-Medium (20-100) |
| Template/resource pages | `/templates/[template]` | template name, description, preview, category | Medium (50-500) |

**Data signals to look for**: integration configs, competitor list, feature flags/definitions, template library, customer segments.

## Marketplace / Directory

| Page Type | URL Pattern | Data Required | Volume Potential |
|-----------|------------|---------------|-----------------|
| Listing pages | `/[category]/[listing-slug]` | listing details, images, reviews, contact | High (100-100K) |
| Location pages | `/[service]-in-[city]` | service types, city data, local listings | Very High (services × cities) |
| Category + location | `/[category]/[city]` | category, location, filtered listings | Very High |
| Profile pages | `/providers/[name]` | provider details, services, reviews, portfolio | High |
| Top lists | `/best-[category]-in-[city]` | category, location, ranked listings | Very High |

**Data signals to look for**: listing database, service categories, location/geolocation data, review/rating data, provider profiles.

## Content / Media / Publishing

| Page Type | URL Pattern | Data Required | Volume Potential |
|-----------|------------|---------------|-----------------|
| Topic pages | `/topics/[topic]` | topic name, description, related articles | Medium (100-1K) |
| Glossary pages | `/glossary/[term]` | term, definition, related terms, examples | Medium (100-1K) |
| Tag/taxonomy pages | `/tags/[tag]` | tag name, tagged content list | Medium (50-500) |
| Author pages | `/authors/[author]` | author name, bio, articles by author | Low-Medium (10-200) |
| Stats/data pages | `/statistics/[topic]` | topic, data points, sources, charts | Medium |
| How-to/guide pages | `/how-to/[task]` | task name, steps, tools needed, FAQs | Medium (50-500) |

**Data signals to look for**: article/content database, tag taxonomy, author profiles, structured data/statistics, glossary terms.

## Local Business / Services

| Page Type | URL Pattern | Data Required | Volume Potential |
|-----------|------------|---------------|-----------------|
| Service + city | `/[service]/[city]` | service description, city info, local details | High (services × cities) |
| Neighborhood pages | `/[service]/[city]/[neighborhood]` | service, neighborhood details, local data | Very High |
| Service pages | `/services/[service]` | service name, description, pricing, FAQs | Low (10-50) |
| Industry pages | `/industries/[industry]` | industry name, relevant services, case studies | Low-Medium (10-50) |

**Data signals to look for**: service catalog, location/area database, pricing data, customer testimonials by location, industry classifications.

## Evaluating Combination Potential

pSEO scales through **combinations of dimensions**. The most powerful pattern is crossing two or more data axes:

| Dimension A | × Dimension B | = Page Count |
|-------------|---------------|-------------|
| 50 services | × 200 cities | = 10,000 pages |
| 100 products | × 20 use cases | = 2,000 pages |
| 30 tools | × 30 competitors | = 900 comparison pages |
| 500 listings | × 10 categories | = 5,000 filtered views |

**Warning**: Combinations scale fast. Validate that every combination produces a genuinely useful page. `[obscure-service] in [tiny-town]` with zero local data is a thin page.

## Red Flags — When NOT to Do pSEO

- **Fewer than 50 unique records**: Not enough scale to justify the infrastructure
- **No structured attributes**: Just a name and one-sentence description per record = thin pages
- **No search demand**: The keyword patterns have zero search volume
- **High-authority competition only**: If page 1 is all Wikipedia, government sites, and major brands, pSEO pages won't rank
- **Data requires human curation per page**: If each page needs manual writing, it's not programmatic
- **One-dimensional data**: Only one varying field (e.g., just city names with no local data) = pure variable-swap pages
