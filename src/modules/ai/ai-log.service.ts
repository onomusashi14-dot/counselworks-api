/**
 * src/modules/ai/ai-log.service.ts
 *
 * Structured logging for every Claude API call. Writes to activity_log via the
 * existing auditLog helper so we keep one code path for activity writes.
 *
 * NOTE on schema: ActivityLog.entityId is a UUID column — it cannot store
 * arbitrary strings like "system". When no case is in scope we fall back to
 * the firmId, which is guaranteed to be a valid UUID and keeps every AI call
 * attached to *something* queryable.
 */

import type { AICallResult } from './ai-client';
import { logActivity } from '../../utils/auditLog';

export interface LogAICallParams {
  firmId: string;
  caseId?: string;
  endpoint: string;
  triggeringUserId?: string;
  inputSummary: string;
  result: AICallResult;
}

export async function logAICall(params: LogAICallParams): Promise<void> {
  const { firmId, caseId, endpoint, triggeringUserId, inputSummary, result } = params;

  const descriptionParts = [
    `AI endpoint: ${endpoint}`,
    `Model: ${result.model}`,
    `Success: ${result.success}`,
    `Tokens: ${result.inputTokens}in/${result.outputTokens}out`,
    `Duration: ${result.durationMs}ms`,
    `Input: ${inputSummary.substring(0, 200)}`,
    result.success
      ? `Output: ${JSON.stringify(result.output).substring(0, 300)}`
      : `Error: ${result.rawResponse.substring(0, 200)}`,
  ];

  await logActivity({
    firmId,
    actorId: triggeringUserId,
    actorType: 'ai',
    entityType: caseId ? 'case' : 'firm',
    entityId: caseId ?? firmId,
    activityType: 'ai_call',
    description: descriptionParts.join(' | '),
    metadata: {
      endpoint,
      model: result.model,
      success: result.success,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      duration_ms: result.durationMs,
      // Truncated for storage — raw responses can be large.
      output_preview: JSON.stringify(result.output).substring(0, 1000),
      triggering_user_id: triggeringUserId,
    },
  });
}
