type QueueFields = {
  queue_position: number;
  estimated_start_at: string | null;
};

type WaitReason = 'waiting_for_capacity' | 'daily_capacity_reached';

export type QuoteCapacity =
  | { starts: 'now' }
  | ({ starts: 'queued'; reason: WaitReason; resets_at?: string } & QueueFields);

const fail = (): never => { throw new Error('Invalid order capacity response.'); };

const timestamp = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) return fail();
  return value;
};

export function orderQueueFields(value: Record<string, unknown>): Partial<QueueFields> {
  const position = value['queue_position'];
  const estimated = value['estimated_start_at'];
  if (position === undefined && estimated === undefined) return {};
  if (typeof position !== 'number' || !Number.isSafeInteger(position) || position < 1) return fail();
  return { queue_position: position, estimated_start_at: estimated === null ? null : timestamp(estimated) };
}

export function quoteCapacityFields(value: Record<string, unknown>): { capacity?: QuoteCapacity } {
  const capacity = value['capacity'];
  if (capacity === undefined) return {};
  if (typeof capacity !== 'object' || capacity === null || Array.isArray(capacity)) return fail();
  const fields = capacity as Record<string, unknown>;
  if (fields['starts'] === 'now') return { capacity: { starts: 'now' } };
  const reason = fields['reason'];
  if (fields['starts'] !== 'queued' || (reason !== 'waiting_for_capacity' && reason !== 'daily_capacity_reached')) return fail();
  const { queue_position, estimated_start_at } = orderQueueFields(fields);
  if (queue_position === undefined || estimated_start_at === undefined) return fail();
  return { capacity: {
    starts: 'queued', reason, queue_position, estimated_start_at,
    ...(fields['resets_at'] === undefined ? {} : { resets_at: timestamp(fields['resets_at']) }),
  } };
}
