export interface PushEvent {
  action_name: string;
  created_at: string;
  push_data?: { commit_count: number } | null;
}

export function aggregatePushEvents(
  events: readonly PushEvent[],
  startDate: string,
  endDate: string,
  dateOf: (timestamp: string) => string,
): { pushEvents: number; days: { date: string; count: number }[] } {
  const counts = new Map<string, number>();
  let pushEvents = 0;
  for (const event of events) {
    if (!event.action_name.startsWith("pushed") || !event.created_at) continue;
    const date = dateOf(event.created_at);
    if (date < startDate || date > endDate) continue;
    pushEvents += 1;
    const count = Math.max(0, event.push_data?.commit_count ?? 0);
    counts.set(date, (counts.get(date) ?? 0) + count);
  }
  return {
    pushEvents,
    days: [...counts].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}
