import type { JsonObject, JsonValue } from '../../src/types.js';

export function withHostEvidence(source: JsonObject, facts: Partial<{
  tool_call_count: number; mutation_count: number; verified_mutation_count: number;
  discovery_observed: boolean; validation_observed: boolean; completion_ready: boolean;
}> = {}): JsonObject {
  const result = structuredClone(source);
  const meta = result.kitt_meta as JsonObject;
  const context = (result.kitt_context ?? { schema_version: 1, epoch: 'test', segments: [] }) as JsonObject;
  const segments = (context.segments ?? []) as JsonObject[];
  const previous = segments.find(s => s.id === 'host-execution-state')?.body_ref as JsonObject | undefined;
  const state = {
    schema_version: 1, conversation_id: meta.conversation_id, turn_id: meta.turn_id,
    tool_call_count: 0, mutation_count: 0, verified_mutation_count: 0,
    discovery_observed: false, validation_observed: false, completion_ready: true,
    ...(previous?.host_execution as JsonObject ?? {}), ...facts
  };
  context.segments = [
    ...segments.filter(s => s.id !== 'host-execution-state'),
    { id: 'host-execution-state', kind: 'OUTPUT_CONTRACT', source: 'host-execution', trust: 'TRUSTED',
      stability: 'TURN', priority: 100, sensitivity: 'PRIVATE', recovery: 'EXACT', cache_region: 'LIVE_ZONE',
      lifecycle: 'turn', provenance_digest: 'test-host', token_cost: 16, body_ref: { host_execution: state } }
  ] as JsonValue[];
  result.kitt_context = context;
  return result;
}
