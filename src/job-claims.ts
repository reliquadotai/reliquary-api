import { parseJob, parseJobAttempt, type JobView, type JobAttempt } from './jobs.js';

/** Worker claims are separate from public job views; lease credentials never enter those views. */
export type JobClaim = { schema_version: 1; job: JobView | null; attempt: (JobAttempt & { lease_token: string }) | null };
export function parseJobClaim(value: unknown): JobClaim {
  const fail = (): never => { throw new Error('Invalid worker claim.'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (v['schema_version'] !== 1) fail();
  if (v['job'] === null && v['attempt'] === null) return { schema_version: 1, job: null, attempt: null };
  const job = parseJob(v['job']), attempt = parseJobAttempt(v['attempt']);
  const a = v['attempt'] as Record<string, unknown>;
  const token = a['lease_token'];
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || job.kind !== 'dataset_validation' || job.state !== 'running' ||
      attempt.job_id !== job.id || attempt.state !== 'running' || job.current_attempt_id !== attempt.id ||
      !job.attempts.some(current => Object.entries(attempt).every(([key, field]) => current[key as keyof JobAttempt] === field))) fail();
  return { schema_version: 1, job, attempt: { ...attempt, lease_token: token as string } };
}
