import {
  parseSubnetCatalog, parseSubnetManifest, parseSubnetRun, parseSubnetRuns,
  type SubnetRun, type SubnetTaskManifest,
} from './subnet-tasks.js';
import { GenerationApiError } from './generation.js';

/** The browser's administrator transport owns wallet verification and action proofs. */
export type SubnetOperatorTransport = (path: string, init?: RequestInit, confirmation?: string) => Promise<unknown>;
const root = '/api/admin/subnet/tasks';
const id = (value: string) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new Error('Invalid task identifier.');
  return value;
};
const receipt = (value: unknown) => parseSubnetRun(value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)['run'] : null);

export function createSubnetTaskClient(request: SubnetOperatorTransport) {
  const mutate = async (path: string, init: RequestInit, confirmation: string) => {
    try { return await request(path, init, confirmation); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
      if (error instanceof GenerationApiError && error.code === 'outcome_unknown') throw error;
      if (typeof status === 'number' && status >= 400 && status < 500 && status !== 408) throw error;
      throw new GenerationApiError('outcome_unknown', typeof status === 'number' ? status : undefined, new Headers(init.headers).get('Idempotency-Key') ?? undefined);
    }
  };
  return {
    catalog: async () => parseSubnetCatalog(await request('/api/admin/subnet/catalog')),
    runs: async () => parseSubnetRuns(await request(root)),
    detail: async (taskId: string) => {
      const next = receipt(await request(root + '/' + id(taskId)));
      if (next.id !== taskId) throw new Error('The task response did not match this request.');
      return next;
    },
    launch: async (input: SubnetTaskManifest, requestId: string) => {
      const manifest = parseSubnetManifest(input);
      id(requestId);
      const value = await mutate(root, { method: 'POST', headers: { 'Idempotency-Key': requestId }, body: JSON.stringify({ schemaVersion: 1, requestId, manifest }) },
        'Launch ' + manifest.name + ' on the subnet with ' + manifest.promptCount + ' prompts and an incentive cap of ' + manifest.incentiveCap + '. The pinned model and environment in this review are the exact launch inputs.');
      try {
        const next = receipt(value);
        if (Object.entries(manifest).some(([key, field]) => next.manifest[key as keyof SubnetTaskManifest] !== field)) throw new Error();
        return next;
      } catch { throw new GenerationApiError('outcome_unknown', undefined, requestId, 'The launch receipt did not match the reviewed task. Retry the same confirmation.'); }
    },
    cancel: async (input: SubnetRun, reason: string) => {
      const run = parseSubnetRun(input);
      if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500 || /[\x00-\x1f\x7f]/.test(reason)) throw new Error('Review the cancellation reason.');
      const value = await mutate(root + '/' + id(run.id) + '/cancel', { method: 'POST', headers: { 'X-Resource-Revision': run.revision }, body: JSON.stringify({ revision: run.revision, reason: reason.trim() }) },
        'Retire ' + run.name + ' from new subnet work. In-flight submissions must drain before delivery.');
      try {
        const next = receipt(value);
        if (next.id !== run.id || next.manifestSha256 !== run.manifestSha256) throw new Error();
        return next;
      } catch { throw new GenerationApiError('outcome_unknown', undefined, undefined, 'The cancellation receipt did not match this task. Refresh its state.'); }
    },
  };
}
