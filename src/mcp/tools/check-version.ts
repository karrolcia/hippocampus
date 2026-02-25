import { getEntityVersion, type EntityVersion } from '../../db/entities.js';

export interface CheckVersionInput {
  entity: string;
  version_hash?: string;
}

export interface CheckVersionResult {
  entity: string;
  current_hash: string | null;
  version_at: string | null;
  observation_count: number;
  is_current: boolean;
}

export function checkVersion(input: CheckVersionInput): CheckVersionResult {
  const version = getEntityVersion(input.entity);

  if (!version) {
    return {
      entity: input.entity,
      current_hash: null,
      version_at: null,
      observation_count: 0,
      is_current: false,
    };
  }

  const isCurrent = input.version_hash !== undefined
    ? input.version_hash === version.version_hash
    : false;

  return {
    entity: input.entity,
    current_hash: version.version_hash,
    version_at: version.version_at,
    observation_count: version.observation_count,
    is_current: isCurrent,
  };
}
