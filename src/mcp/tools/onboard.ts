import { listEntities } from '../../db/entities.js';
import { getObservationsByEntity } from '../../db/observations.js';

export interface OnboardInput {
  source?: string;
}

export interface OnboardResult {
  instructions: string;
  existing_entities: string[];
  observation_count: number;
}

export function onboard(input: OnboardInput): OnboardResult {
  const entities = listEntities({ limit: 10000 });
  let totalObservations = 0;
  for (const e of entities) {
    totalObservations += getObservationsByEntity(e.id).length;
  }

  const existingNames = entities.map(e => e.name);

  const sourceHint = input.source
    ? `You are running in ${input.source}. `
    : '';

  const instructions = `${sourceHint}Extract what you know about the user into Hippocampus memory. Follow these steps:

1. **Inventory** — List everything you know about this user across these categories:
   - Identity (name, location, background, languages)
   - Professional roles and affiliations
   - Active projects (name, description, status)
   - Skills and expertise
   - Preferences (tools, workflows, communication style)
   - Key decisions or principles they follow
   - Reasoning behind important decisions (not just what, but why — tradeoffs weighed, options rejected)
   - Half-formed ideas or open questions they are exploring

2. **Check existing** — These entities already exist: ${existingNames.length > 0 ? existingNames.join(', ') : '(none)'}. Avoid storing duplicates. Use the same entity names for updates.

3. **Store** — For each piece of information, call the \`remember\` tool:
   - \`entity\`: Use the person's name for identity facts, "project:<name>" for projects, "preference" for preferences
   - \`type\`: "person", "project", "preference", "skill", "organization"
   - \`kind\`: "fact", "decision", "preference", "rationale", "exploration"
   - \`content\`: Telegraphic form for facts — drop articles, pronouns, filler. One fact per call. Richer kinds can be longer.
   - Examples:
     - Fact: remember({ entity: "karolina", type: "person", kind: "fact", content: "PhD atmospheric physics, TU Delft" })
     - Decision + rationale: remember({ entity: "project:hippocampus", kind: "decision", content: "Dropped remote Claude Code feature" }) then remember({ entity: "project:hippocampus", kind: "rationale", content: "Anthropic shipped native session sync — building commodity infrastructure wastes time better spent on core differentiator" })
     - Exploration: remember({ entity: "project:hippocampus", kind: "exploration", content: "Half-formed: what if memory server distinguished between facts and skills? Skills shape behavior, facts inform it. Not sure where the boundary is." })

4. **Relationships** — Relationships between entities are auto-detected when entity names appear in content. Mention related entity names naturally.

5. **Verify** — After storing, call \`recall\` with a broad query to confirm the knowledge was captured correctly.`;

  return {
    instructions,
    existing_entities: existingNames,
    observation_count: totalObservations,
  };
}
