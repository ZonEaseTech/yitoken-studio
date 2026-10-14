// YITOKEN changes: preserve timeline ownership when explicitly duplicating a project.
// AGPL-3.0-or-later. See LICENSE and NOTICE.md.
export function copyProjectTimeline(raw: string, sourceId: string, targetId: string): string {
  const parsed = JSON.parse(raw);
  const state = parsed?.state ?? parsed;
  if (!state || !Array.isArray(state.clips) || (state.boundProjectId && state.boundProjectId !== sourceId)) throw new Error('Invalid copied timeline ownership');
  state.boundProjectId = targetId;
  if (state.activeProjectId === sourceId) state.activeProjectId = targetId;
  // The source file remains untouched; clips retain their media references/order.
  return JSON.stringify(parsed);
}
