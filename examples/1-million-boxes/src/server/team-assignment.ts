/**
 * Simple random team assignment.
 * Returns a team ID (0-3).
 */
export function assignTeam(): number {
  return Math.floor(Math.random() * 4)
}

// Future: balanced assignment using KV for tracking team counts
// export async function assignTeamBalanced(kv: KVNamespace): Promise<number> {
//   const counts = await Promise.all([
//     kv.get('team:0:count').then(v => parseInt(v || '0')),
//     kv.get('team:1:count').then(v => parseInt(v || '0')),
//     kv.get('team:2:count').then(v => parseInt(v || '0')),
//     kv.get('team:3:count').then(v => parseInt(v || '0')),
//   ]);
//
//   const minCount = Math.min(...counts);
//   const candidates = counts
//     .map((c, i) => (c === minCount ? i : -1))
//     .filter(i => i !== -1);
//
//   const teamId = candidates[Math.floor(Math.random() * candidates.length)];
//   await kv.put(`team:${teamId}:count`, String(counts[teamId] + 1));
//
//   return teamId;
// }
