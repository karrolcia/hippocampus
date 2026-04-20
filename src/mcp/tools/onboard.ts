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

export function onboard(input: OnboardInput): OnboardResult {
  const recentEntities = listEntities({ limit: RECENT_ENTITY_LIMIT });
  const totalEntities = getTotalEntityCount();
  const totalObservations = getTotalObservationCount();

  const recentNames = recentEntities.map(e => e.name);

  const sourceHint = input.source
    ? `You are running in ${input.source}. `
    : '';

  let existingSection: string;
  if (totalEntities === 0) {
    existingSection = 'No entities exist yet — this is a fresh memory store.';
  } else {
    const namespaceCounts = getNamespaceCounts();
    const namespaceSummary = namespaceCounts
      .map(n => `\`${n.namespace}\` (${n.count})`)
      .join(', ');
    existingSection = `${totalEntities} entities, ${totalObservations} observations already stored.

   **Namespaces in use**: ${namespaceSummary}

   **${recentEntities.length} most recently updated**: ${recentNames.join(', ')}

   For duplicate detection beyond the recent list, call \`recall\` with the candidate name or a semantic query before creating a new entity.`;
  }

  const instructions = `${sourceHint}Extract what you know about the user into Hippocampus memory. Follow these steps:

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
   - Examples:
     - Fact: remember({ entity: "karolina", type: "person", kind: "fact", content: "PhD atmospheric physics, TU Delft" })
     - Decision + rationale: remember({ entity: "project:hippocampus", kind: "decision", content: "Dropped remote Claude Code feature" }) then remember({ entity: "project:hippocampus", kind: "rationale", content: "Anthropic shipped native session sync — building commodity infrastructure wastes time better spent on core differentiator" })
     - Exploration: remember({ entity: "project:hippocampus", kind: "exploration", content: "Half-formed: what if memory server distinguished between facts and skills? Skills shape behavior, facts inform it. Not sure where the boundary is." })
     - Pattern: remember({ entity: "pattern:unfunded-visionary", type: "pattern", kind: "fact", content: "Technically literate, no funding, seeks advisor credibility validation. Signal: asks you to be front-facing for their venture. Not a prospect — ask doesn't match paid advisory." })

4. **Relationships** — Relationships between entities are auto-detected when entity names appear in content. Mention related entity names naturally.

5. **Verify** — After storing, call \`recall\` with a broad query to confirm the knowledge was captured correctly.`;

  return {
    instructions,
    existing_entities: recentNames,
    observation_count: totalObservations,
  };
}
