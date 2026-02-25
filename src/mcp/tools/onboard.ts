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

2. **Check existing** — These entities already exist: ${existingNames.length > 0 ? existingNames.join(', ') : '(none)'}. Avoid storing duplicates. Use the same entity names for updates.

3. **Store** — For each piece of information, call the \`remember\` tool:
   - \`entity\`: Use the person's name for identity facts, "project:<name>" for projects, "preference" for preferences
   - \`type\`: "person", "project", "preference", "skill", "organization"
   - \`kind\`: "fact", "decision", "preference"
   - \`content\`: Telegraphic form — drop articles, pronouns, filler. One fact per call.
   - Example: remember({ entity: "karolina", type: "person", kind: "fact", content: "PhD atmospheric physics, TU Delft" })

4. **Relationships** — Relationships between entities are auto-detected when entity names appear in content. Mention related entity names naturally.

5. **Verify** — After storing, call \`recall\` with a broad query to confirm the knowledge was captured correctly.`;

  return {
    instructions,
    existing_entities: existingNames,
    observation_count: totalObservations,
  };
}
