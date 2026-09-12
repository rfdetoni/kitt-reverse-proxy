export type RuntimeOperationEffect = 'explore' | 'mutate' | 'neutral' | 'mixed';

const RUNTIME_OPERATION_EFFECTS = new Map<string, RuntimeOperationEffect>([
  ['repo.read', 'explore'],
  ['repo.list', 'explore'],
  ['repo.search', 'explore'],
  ['repo.inspect_symbol', 'explore'],
  ['repo.read_symbol', 'explore'],
  ['repo.references', 'explore'],
  ['repo.context_map', 'explore'],
  ['repo.definition', 'explore'],
  ['repo.hover', 'explore'],
  ['repo.references_semantic', 'explore'],
  ['repo.diagnostics', 'explore'],
  ['repo.call_hierarchy', 'explore'],
  ['repo.outline', 'explore'],
  ['repo.ast_search', 'explore'],
  ['security.scan', 'explore'],

  ['repo.edit_symbol', 'mutate'],
  ['repo.write_file', 'mutate'],
  ['repo.create_directory', 'mutate'],
  ['repo.move', 'mutate'],
  ['repo.rename', 'mutate'],
  ['repo.delete', 'mutate'],
  ['artifacts.store', 'mutate'],
  ['patch.apply', 'mutate'],
  ['children.spawn', 'mutate'],
  ['goal.update', 'mutate'],
  ['memory.correct', 'mutate'],
  ['memory.concept', 'mutate'],
  ['memory.link', 'mutate'],
  ['mcp.call', 'mutate'],
  ['state.set', 'mutate'],

  ['process.run', 'mixed'],

  ['flow.execute', 'neutral'],
  ['artifacts.read', 'neutral'],
  ['children.send', 'neutral'],
  ['children.inspect', 'neutral'],
  ['goal.inspect', 'neutral'],
  ['memory.query', 'neutral'],
  ['session.search', 'neutral'],
  ['skill.call', 'neutral'],
  ['state.get', 'neutral'],
  ['state.list', 'neutral'],
  ['handles.resolve', 'neutral']
]);

export function runtimeOperationEffect(operation: unknown): RuntimeOperationEffect | undefined {
  return typeof operation === 'string' ? RUNTIME_OPERATION_EFFECTS.get(operation) : undefined;
}

export function runtimeOperationPolicySnapshot(): Readonly<Record<string, RuntimeOperationEffect>> {
  return Object.freeze(Object.fromEntries(RUNTIME_OPERATION_EFFECTS));
}
