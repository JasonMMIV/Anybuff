import { LITE_MODEL, publisher } from '../constants'
import type { SecretAgentDefinition } from '../types/secret-agent-definition'
import { createReviewer } from './code-reviewer'

/**
 * The reviewer Codebuff's paid LITE mode spawns, on the same model as the
 * orchestrator. AnyBuff: per-model reviewers were removed (ADR-15 follow-up);
 * all other modes fall back to the generic code-reviewer.
 */
const definition: SecretAgentDefinition = {
  id: 'code-reviewer-lite',
  publisher,
  ...createReviewer(LITE_MODEL),
}

export default definition
