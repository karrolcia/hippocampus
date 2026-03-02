# Content Model Reference

## Two-Tier Data Architecture

At 1000+ pages, loading full content for every page simultaneously will exceed Node.js memory limits. Split models into two tiers:

- **Index tier** (~1KB/page): Safe to hold all in memory. Used by `getAllSlugs()`, `getRelatedPages()`, `getPagesByCategory()`.
- **Full tier** (~50-500KB/page): Load one page at a time. Used by `getPageData()`.

## Page Index Interface (Lightweight)

```typescript
interface PageIndex {
  slug: string;
  canonicalPath: string;
  title: string;
  metaDescription: string;
  h1: string;
  category: string;
  subcategory?: string;
  tags?: string[];
  publishedDate: string;
  lastModified: string;
  status: "published" | "draft";
}
```

## Full Page Content Interface (Heavy)

Every pSEO content type must extend `PageIndex` with the heavy fields:

```typescript
interface BaseSEOContent extends PageIndex {
  // Content (heavy fields — only load per-page)
  introText: string;               // 1-3 sentence intro paragraph
  bodyContent: string;             // main content (HTML or MDX)
  faqs?: FAQ[];                    // structured FAQ pairs

  // Linking
  relatedSlugs?: string[];         // manually curated related pages
  parentSlug?: string;             // for hierarchical content

  // Media
  featuredImage?: SEOImage;
}

interface FAQ {
  question: string;
  answer: string;                  // can include HTML
}

interface SEOImage {
  src: string;
  alt: string;
  width: number;
  height: number;
}
```

## Example Extended Types

### Location-based pSEO
```typescript
interface LocationPage extends BaseSEOContent {
  city: string;
  state: string;
  country: string;
  coordinates?: { lat: number; lng: number };
  localAttributes: Record<string, string>;
}
```

### Product/Service pSEO
```typescript
interface ProductPage extends BaseSEOContent {
  productName: string;
  price?: { amount: number; currency: string };
  features: string[];
  specifications: Record<string, string>;
  rating?: { value: number; count: number };
}
```

### Comparison pSEO
```typescript
interface ComparisonPage extends BaseSEOContent {
  itemA: { name: string; attributes: Record<string, string> };
  itemB: { name: string; attributes: Record<string, string> };
  verdict: string;
  comparisonPoints: {
    dimension: string;
    itemAValue: string;
    itemBValue: string;
    winner: "a" | "b" | "tie";
  }[];
}
```

### Hub/Category Page
```typescript
interface CategoryPage extends BaseSEOContent {
  categoryName: string;
  categoryDescription: string;
  childCount: number;
  featuredChildren: string[];       // slugs of featured child pages
}
```

## Data Layer API Contract

```typescript
interface PSEODataLayer {
  // --- Index tier (lightweight, safe to hold all in memory) ---

  // Must handle internal pagination for data sources with 1000+ records.
  // The consumer never paginates — this function returns the complete list.
  getAllSlugs(): Promise<{ slug: string; category: string }[]>;

  // Returns lightweight PageIndex objects — no body content or media
  getPagesByCategory(
    category: string,
    opts?: { limit?: number; offset?: number }
  ): Promise<PageIndex[]>;

  // Returns lightweight PageIndex objects for linking
  getRelatedPages(slug: string, limit?: number): Promise<PageIndex[]>;

  getAllCategories(): Promise<CategoryPage[]>;

  // Useful for sitemap splitting (>50k URLs) and build diagnostics
  getPageCount(): Promise<number>;

  // --- Full tier (heavy, load one at a time) ---

  // Returns the FULL page content. Only call for a single page at a time.
  // Never use with Promise.all() over the full slug list.
  getPageData<T extends BaseSEOContent>(slug: string): Promise<T | null>;

  // --- Validation ---
  validateAllData(): Promise<ValidationResult>;
}

interface ValidationResult {
  valid: boolean;
  errors: { slug: string; field: string; message: string }[];
  warnings: { slug: string; field: string; message: string }[];
}
```
