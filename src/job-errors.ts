/** An uncertain mutation must be reconciled using its original intent and identifiers. */
export class JobApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status?: number,
    public readonly requestKey?: string,
    public readonly revision?: string,
  ) { super(`Job API request failed: ${code}.`); }
}
