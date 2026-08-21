import { listEntities } from '../../db/entities.js';
import { getDatabase } from '../../db/index.js';

export interface OnboardInput {
  source?: string;
}

export interface OnboardResult {
  instructions: string;
  existing_entities: string[];
  observation_count: number;
}

const RECENT_ENTITY_LIMIT = 30;

/**
 * Below this observation count, the prompt assumes a cold start and asks the AI
 * to do a full inventory extraction. Above it, the prompt switches to delta
 * capture — the dominant mode for mature memory stores.
 */
const BOOTSTRAP_THRESHOLD = 50;

interface NamespaceCount {
  namespace: string;
  count: number;
}

function getTotalObservationCount(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM observations').get() as { count: number };
  return row.count;
}

function getTotalEntityCount(): number {
  const db = getDatabase();
  const row = db.prepare('SELECT COUNT(*) as count FROM entities').get() as { count: number };
  return row.count;
}

function getNamespaceCounts(): NamespaceCount[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      CASE
        WHEN instr(name, ':') > 0 THEN substr(name, 1, instr(name, ':') - 1)
        ELSE '(no prefix)'
      END AS namespace,
      COUNT(*) AS count
    FROM entities
    GROUP BY namespace
    ORDER BY count DESC
  `).all() as NamespaceCount[];
}

function buildExistingSection(totalEntities: number, totalObservations: number, recentNames: string[]): string {
  if (totalEntities === 0) {
    return 'No entities exist yet — this is a fresh memory store.';
  }
  const namespaceCounts = getNamespaceCounts();
  const namespaceSummary = namespaceCounts
    .map(n => `\`${n.namespace}\` (${n.count})`)
    .join(', ');
  return `${totalEntities} entities, ${totalObservations} observations already stored.

   **Namespaces in use**: ${namespaceSummary}

   **${recentNames.length} most recently updated**: ${recentNames.join(', ')}

   For duplicate detection beyond the recent list, call \`recall\` with the candidate name or a semantic query before creating a new entity.`;
}

function bootstrapPrompt(sourceHint: string, existingSection: string): string {
  return `${sourceHint}Extract what you know about the user into Hippocampus memory. Follow these steps:

1. **Inventory** — List everything you know about this user across these categories:
   - Identity (name, location, background, languages)
   - Professional roles and affiliations
   - Active projects (name, description, status)
   - Skills and expertise
   - Preferences (tools, workflows, communication style)
   - Key decisions or principles they follow
   - Reasoning behind important decisions (not just what, but why — tradeoffs weighed, options rejected)
   - Recurring patterns the user diagnoses across encounters (founder archetypes, sales traps, failure modes). Signal: user references past cases by shorthand ("this is another X"). Store as its own entity so future matches are instant.
   - Half-formed ideas or open questions they are exploring

2. **Check existing** — ${existingSection}

   Use the same entity names for updates. Mimic the naming conventions shown above.

3. **Store** — For each piece of information, call the \`remember\` tool:
   - \`entity\`: Use the person's name for identity facts, "project:<name>" for projects, "pattern:<name>" for archetypes, "preference" for preferences
   - \`type\`: "person", "project", "pattern", "preference", "skill", "organization"
   - \`kind\`: "fact", "decision", "preference", "rationale", "exploration"
   - \`content\`: Telegraphic form for facts — drop articles, pronouns, filler. One fact per call. Richer kinds can be longer.
   - \`importance\`: Pass 1.5–2.0 for identity facts, core principles, and load-bearing decisions. Default 1.0.
   - Examples:
     - Fact: remember({ entity: "karolina", type: "person", kind: "fact", content: "PhD atmospheric physics, TU Delft", importance: 2.0 })
     - Decision + rationale: remember({ entity: "project:hippocampus", kind: "decision", content: "Dropped remote Claude Code feature" }) then remember({ entity: "project:hippocampus", kind: "rationale", content: "Anthropic shipped native session sync — building commodity infrastructure wastes time better spent on core differentiator" })
     - Exploration: remember({ entity: "project:hippocampus", kind: "exploration", content: "Half-formed: what if memory server distinguished between facts and skills? Skills shape behavior, facts inform it. Not sure where the boundary is." })
     - Pattern: remember({ entity: "pattern:unfunded-visionary", type: "pattern", kind: "fact", content: "Technically literate, no funding, seeks advisor credibility validation. Signal: asks you to be front-facing for their venture. Not a prospect — ask doesn't match paid advisory." })

4. **Relationships** — Relationships between entities are auto-detected when entity names appear in content. Mention related entity names naturally.

5. **Verify** — After storing, call \`check_version({entity: "<name>"})\` on a few entities to confirm the writes succeeded (a non-null \`version_hash\` means the entity exists and has observations).`;
}

function ongoingPrompt(sourceHint: string, existingSection: string): string {
  return `${sourceHint}You are working with an established Hippocampus memory store. Do not re-extract what already exists — capture deltas only. This is the dominant mode for mature instances.

**Current state** — ${existingSection}

1. **Capture when:**
   - User states a new fact, decision, or rationale not already in memory
   - User diagnoses a recurring pattern (capture as \`pattern:<archetype>\`)
   - User gives feedback or correction about how to work
   - The conversation reaches a meaningful decision (not just discussion)
   - User says "save this", "remember that", "store the frame", "log this"
   - User shares an artifact (article, frame, framework) worth banking

2. **Do not capture:**
   - Identity facts already in memory — call \`recall\` first with the candidate content
   - Ephemeral task details that won't matter next session
   - Repetition of existing observations
   - Anything derivable from public sources without user-specific framing
   - Generic best-practice advice

3. **Store** — For each captured item, call the \`remember\` tool:
   - \`entity\`: Mimic the naming conventions in the namespace summary above. Bare name for the user; \`project:<slug>\`, \`pattern:<archetype>\`, \`skill:<name>\`, \`preference\`, \`ops:<context>\`, \`raw:<type>:<slug>\` for everything else.
   - \`type\`: "person", "project", "pattern", "preference", "skill", "organization"
   - \`kind\`: "fact", "decision", "rationale", "pattern", "preference", "exploration", "session-log"
   - \`content\`: Telegraphic form — drop articles, pronouns, filler. One claim per call. Richer kinds can be longer.
   - \`importance\`: Pass 1.5–2.0 for identity facts, core principles, and load-bearing decisions. Default 1.0.

4. **On the \`remember\` response — handle \`near_matches\`:**
   - \`novelty\` < 0.3 (and a near-match exists with high overlap) → use \`update\` on the existing observation, or \`merge\` if multiple cluster. Do not accumulate duplicates.
   - **Exception — \`append_only: true\` in the response:** the entity is a log (dated entries sharing a format). Overlap between entries is expected and is NOT redundancy. Never \`update\`, \`merge\` or otherwise consolidate its observations, whatever the novelty score says; its \`near_matches\` are truncated previews, not full content.
   - \`novelty\` 0.3–0.6 → capture, but note the relationship to the near-match in your reasoning.
   - \`novelty\` > 0.6 → genuine new information.

5. **Relationships** — auto-detected when entity names appear in content. Mention related entity names naturally.

6. **Verify** — After storing, call \`check_version({entity: "<name>"})\` on the entity. A non-null \`version_hash\` confirms the write took effect; the AI can cache that hash and re-check later to detect staleness.

**Delta-capture examples:**
- New decision in this conversation: remember({ entity: "project:hippocampus", kind: "decision", content: "Branched onboard prompt into bootstrap vs ongoing modes at 50-obs threshold" })
- Pattern caught from a call: remember({ entity: "pattern:unfunded-visionary", type: "pattern", kind: "fact", content: "Technically literate, no funding, seeks advisor credibility validation. Signal: asks you to be front-facing for their venture." })
- Feedback / correction: remember({ entity: "preference:writing-rules", kind: "preference", content: "Never use 'here's what actually works' — banned phrasing", importance: 1.8 })
- Captured artifact: remember({ entity: "artifact:kyle-graph-matrix-frame-2026-04-14", kind: "fact", content: "<distilled frame from conversation>", source: "claude.ai conversation 2026-04-14" })`;
}

export function onboard(input: OnboardInput): OnboardResult {
  const recentEntities = listEntities({ limit: RECENT_ENTITY_LIMIT });
  const totalEntities = getTotalEntityCount();
  const totalObservations = getTotalObservationCount();

  const recentNames = recentEntities.map(e => e.name);

  const sourceHint = input.source
    ? `You are running in ${input.source}. `
    : '';

  const existingSection = buildExistingSection(totalEntities, totalObservations, recentNames);

  const instructions = totalObservations < BOOTSTRAP_THRESHOLD
    ? bootstrapPrompt(sourceHint, existingSection)
    : ongoingPrompt(sourceHint, existingSection);

  return {
    instructions,
    existing_entities: recentNames,
    observation_count: totalObservations,
  };
}
