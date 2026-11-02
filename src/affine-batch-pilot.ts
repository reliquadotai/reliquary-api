import { GenerationApiError } from './generation.js';
import { affinePilotRequests, createAffinePilotClient, type AffinePilotTransport, type AffinePilotRequestDescriptor } from './affine-pilot.js';
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const affineBatchPins = [
  'jobDigest',
  'sourceClosureDigest',
  'runtimeDigest',
  'inputInventoryDigest',
  'miningSha256',
  'batchSha256',
  'headDigest',
  'referenceDigest',
  'tokenizerDigest',
  'evaluatorConfigDigest',
  'checkpointPublishedId',
] as const;
export type AffineBatchPins = Record<(typeof affineBatchPins)[number], string>;
export type AffineBatchContext = {
  upstreamRevision: string;
  masterMode: 'provided' | 'bf16-bootstrap';
  masterDigest: string | null;
  referenceProvenance: 'published-reference' | 'caller-provided-unverified';
  seed: number;
  expectedDraw: number;
  lastGreenDecidedAt: number;
  comparisonClockRule: 'actual-training-result-minus-frozen-last-green';
};
export type AffineBatchProfile = AffineBatchPins &
  AffineBatchContext & {
    schema: 'affine-batch-profile/v1';
    ownerUserId: string;
    billingMode: 'operator-funded-pilot';
    receiptPublicKey: string;
    maxOutputBytes: number;
    maxCostMicroUsd: number;
    jobExpiresAt: number;
  };
export type AffineBatchRequest = {
  schema: 'affine-batch-request/v1';
  profileDigest: string;
  jobDigest: string;
  maxHours: number;
  maxCostMicroUsd: number;
  jobExpiresAt: number;
};
export type AffineBatchReceipt = AffineBatchPins &
  AffineBatchContext & {
    schema: 'affine-batch-receipt/v1';
    taskId: string;
    profileDigest: string;
    requestSha256: string;
    environmentDigest: string;
    candidateDigest: string;
    comparisonDigest: string;
    artifactSha256: string;
    artifactSize: number;
    elapsedSeconds: number;
    jobExpiresAt: number;
    stage: 'batch_comparison_completed';
    device: 'cuda';
    optimizerSteps: 1;
    trainingUpdated: true;
    finiteGradient: true;
    masterChanged: true;
    pgTokens: number;
    supportOutsideTokens: number;
    actualDrawn: number;
    trainingResultAt: number;
    actualTrainingEndedAt: number;
    decision: 'green' | 'red';
    reasons: string[];
    gain: number | null;
    z: number | null;
    se: number | null;
    barZ: number;
    liveParity: false;
    officialAcceptance: false;
    chainSubmission: false;
    nativeRewardVerified: false;
  };
export type AffineBatchResult = {
  schema: 'affine-batch-result/v1';
  receiptArtifactId: string;
  resultArtifactId: string;
  assurance: 'signed-native-mimo-batch-comparison';
  receipt: AffineBatchReceipt;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const finite = (v: unknown, min = 0): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min;
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number =>
  finite(v, min) && Number.isSafeInteger(v) && v <= max;
const contextKeys = [
  'upstreamRevision',
  'masterMode',
  'masterDigest',
  'referenceProvenance',
  'seed',
  'expectedDraw',
  'lastGreenDecidedAt',
  'comparisonClockRule',
] as const;
function context(v: Record<string, unknown>): boolean {
  return (
    typeof v['upstreamRevision'] === 'string' &&
    /^[a-f0-9]{40}$/.test(v['upstreamRevision']) &&
    ['provided', 'bf16-bootstrap'].includes(String(v['masterMode'])) &&
    (v['masterMode'] === 'provided' ? hash(v['masterDigest']) : v['masterDigest'] === null) &&
    ['published-reference', 'caller-provided-unverified'].includes(
      String(v['referenceProvenance']),
    ) &&
    integer(v['seed'], 0, 0xffffffff) &&
    integer(v['expectedDraw'], 1, 19305) &&
    finite(v['lastGreenDecidedAt']) &&
    v['comparisonClockRule'] === 'actual-training-result-minus-frozen-last-green'
  );
}
export function validAffineBatchProfile(v: unknown): v is AffineBatchProfile {
  return (
    record(v) &&
    exact(v, [
      'schema',
      ...affineBatchPins,
      ...contextKeys,
      'ownerUserId',
      'billingMode',
      'receiptPublicKey',
      'maxOutputBytes',
      'maxCostMicroUsd',
      'jobExpiresAt',
    ]) &&
    v['schema'] === 'affine-batch-profile/v1' &&
    context(v) &&
    affineBatchPins.every((k) => hash(v[k])) &&
    typeof v['ownerUserId'] === 'string' &&
    /^[\w-]{1,128}$/.test(v['ownerUserId']) &&
    v['billingMode'] === 'operator-funded-pilot' &&
    hash(v['receiptPublicKey']) &&
    integer(v['maxOutputBytes'], 1, 5 * 1024 ** 3) &&
    integer(v['maxCostMicroUsd'], 1, 1_000_000_000_000) &&
    integer(v['jobExpiresAt'], 1)
  );
}
export function validAffineBatchRequest(v: unknown): v is AffineBatchRequest {
  return (
    record(v) &&
    exact(v, [
      'schema',
      'profileDigest',
      'jobDigest',
      'maxHours',
      'maxCostMicroUsd',
      'jobExpiresAt',
    ]) &&
    v['schema'] === 'affine-batch-request/v1' &&
    hash(v['profileDigest']) &&
    hash(v['jobDigest']) &&
    integer(v['maxHours'], 1, 168) &&
    integer(v['maxCostMicroUsd'], 1, 1_000_000_000_000) &&
    integer(v['jobExpiresAt'], 1)
  );
}
export function validAffineBatchReceipt(v: unknown): v is AffineBatchReceipt {
  if (
    !record(v) ||
    !exact(v, [
      'schema',
      ...affineBatchPins,
      ...contextKeys,
      'taskId',
      'profileDigest',
      'requestSha256',
      'environmentDigest',
      'candidateDigest',
      'comparisonDigest',
      'artifactSha256',
      'artifactSize',
      'elapsedSeconds',
      'jobExpiresAt',
      'stage',
      'device',
      'optimizerSteps',
      'trainingUpdated',
      'finiteGradient',
      'masterChanged',
      'pgTokens',
      'supportOutsideTokens',
      'actualDrawn',
      'trainingResultAt',
      'actualTrainingEndedAt',
      'decision',
      'reasons',
      'gain',
      'z',
      'se',
      'barZ',
      'liveParity',
      'officialAcceptance',
      'chainSubmission',
      'nativeRewardVerified',
    ])
  )
    return false;
  return (
    v['schema'] === 'affine-batch-receipt/v1' &&
    context(v) &&
    [
      ...affineBatchPins,
      'profileDigest',
      'requestSha256',
      'environmentDigest',
      'candidateDigest',
      'comparisonDigest',
      'artifactSha256',
    ].every((k) => hash(v[k])) &&
    typeof v['taskId'] === 'string' &&
    /^[\w-]{1,64}$/.test(v['taskId']) &&
    integer(v['artifactSize'], 1, 5 * 1024 ** 3) &&
    integer(v['elapsedSeconds'], 0, 168 * 3600) &&
    integer(v['jobExpiresAt'], 1) &&
    v['stage'] === 'batch_comparison_completed' &&
    v['device'] === 'cuda' &&
    v['optimizerSteps'] === 1 &&
    v['trainingUpdated'] === true &&
    v['finiteGradient'] === true &&
    v['masterChanged'] === true &&
    integer(v['pgTokens'], 1) &&
    integer(v['supportOutsideTokens'], 0) &&
    integer(v['actualDrawn'], 0, 19305) &&
    finite(v['trainingResultAt']) &&
    v['actualTrainingEndedAt'] === v['trainingResultAt'] &&
    v['trainingResultAt'] >= Number(v['lastGreenDecidedAt']) &&
    ['green', 'red'].includes(String(v['decision'])) &&
    Array.isArray(v['reasons']) &&
    v['reasons'].length <= 20 &&
    v['reasons'].every((r) => typeof r === 'string' && r.length <= 500) &&
    v['candidateDigest'] !== v['headDigest'] &&
    (v['se'] === null || finite(v['se'])) &&
    ['gain', 'z', 'se'].every(
      (k) => v[k] === null || (typeof v[k] === 'number' && Number.isFinite(v[k])),
    ) &&
    finite(v['barZ'], 0.25) &&
    v['barZ'] <= 1 &&
    Math.abs(
      v['barZ'] -
        Math.max(
          0.25,
          1 - (0.75 * (v['trainingResultAt'] - Number(v['lastGreenDecidedAt']))) / 43200,
        ),
    ) <= 1e-12 &&
    ['liveParity', 'officialAcceptance', 'chainSubmission', 'nativeRewardVerified'].every(
      (k) => v[k] === false,
    )
  );
}

export function parseAffineBatchProfile(v: unknown): AffineBatchProfile {
  if (!validAffineBatchProfile(v)) throw new Error('Invalid batch profile.'); return v;
}
export function parseAffineBatchRequest(v: unknown): AffineBatchRequest {
  if (!validAffineBatchRequest(v)) throw new Error('Invalid batch request.'); return v;
}
export function parseAffineBatchReceipt(v: unknown): AffineBatchReceipt {
  if (!validAffineBatchReceipt(v)) throw new Error('Invalid batch receipt.'); return v;
}
export function parseAffineBatchResult(v: unknown): AffineBatchResult {
  if (!record(v) || !exact(v, ['schema', 'receiptArtifactId', 'resultArtifactId', 'assurance', 'receipt']) ||
      v.schema !== 'affine-batch-result/v1' || v.assurance !== 'signed-native-mimo-batch-comparison' ||
      ![v.receiptArtifactId, v.resultArtifactId].every(id => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)) || v.receiptArtifactId === v.resultArtifactId)
    throw new Error('Invalid batch result.');
  parseAffineBatchReceipt(v.receipt); return v as AffineBatchResult;
}
export type AffineBatchPrepared = { request: AffineBatchRequest; configuration: Record<string, unknown>; mode: 'operator-funded-pilot' };
const text = (v: unknown) => typeof v === 'string' && v.trim().length > 0 && v.length <= 500 && !/[\x00-\x1f\x7f]/.test(v);
export function parseAffineBatchPrepared(v: unknown): AffineBatchPrepared {
  if (!record(v) || !exact(v, ['request', 'configuration', 'mode']) || v.mode !== 'operator-funded-pilot') throw new Error('Invalid batch preparation.');
  const request = parseAffineBatchRequest(v.request), c = v.configuration;
  if (!record(c) || !exact(c, ['schemaVersion', 'profileDigest', 'objective', 'environment', 'model', 'optimization', 'compute', 'affineBatchRequest', 'submissionMode']) ||
      c.schemaVersion !== 2 || c.profileDigest !== request.profileDigest || !text(c.objective) || c.submissionMode !== 'operator_funded_pilot' ||
      !record(c.environment) || !exact(c.environment, ['id', 'version']) || !text(c.environment.id) || !text(c.environment.version) ||
      !record(c.model) || !exact(c.model, ['id']) || !text(c.model.id) ||
      !record(c.optimization) || !exact(c.optimization, ['method', 'maxSteps']) || c.optimization.method !== 'affine_batch' || c.optimization.maxSteps !== 1 ||
      !record(c.compute) || !exact(c.compute, ['offerId', 'gpuCount', 'maxHours', 'providerPolicy']) || !text(c.compute.offerId) ||
      !integer(c.compute.gpuCount, 1, 64) || c.compute.maxHours !== request.maxHours || c.compute.providerPolicy !== 'private') throw new Error('Batch configuration differs from approved request.');
  const saved = parseAffineBatchRequest(c.affineBatchRequest);
  if (Object.entries(request).some(([k, value]) => saved[k as keyof AffineBatchRequest] !== value)) throw new Error('Batch configuration request changed.');
  return { request, configuration: c, mode: v.mode };
}
function same(a: unknown, b: unknown): boolean {
  if (record(a) && record(b)) return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => same(v, b[k]));
  return a === b;
}
export type AffineBatchPrepareInput = { profileDigest: string; maxHours: number; maxCostMicroUsd: number };
const stableKey = (v: string) => { if (!/^[\w-]{16,80}$/.test(v)) throw new Error('Use a stable request key.'); return v; };
const post = (path: string, body: unknown, key?: string): AffinePilotRequestDescriptor => ({ path, init: { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': stableKey(key) } : {}) }, body: JSON.stringify(body) } });
export const affineBatchRequests = {
  prepare: (v: AffineBatchPrepareInput) => {
    if (!record(v) || !exact(v, ['profileDigest', 'maxHours', 'maxCostMicroUsd']) || !hash(v.profileDigest) || !integer(v.maxHours, 1, 168) || !integer(v.maxCostMicroUsd, 1, 1_000_000_000_000)) throw new Error('Select approved batch profile, duration and cost.');
    return post('/api/v1/training/affine-batch/prepare', v);
  },
  uploadRequest: (v: AffineBatchRequest, filename: string, rightsConfirmed: true) => {
    const request = parseAffineBatchRequest(v);
    if (rightsConfirmed !== true || !/^[\w .()-]{1,100}\.jsonl$/i.test(filename)) throw new Error('Confirm rights and use a simple .jsonl filename.');
    return { path: '/api/v1/training/files', init: { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson', 'X-Dataset-Format': 'affine_batch_request', 'X-Filename': encodeURIComponent(filename), 'X-Data-Authorized': 'true' }, body: JSON.stringify(request) + '\n' } } satisfies AffinePilotRequestDescriptor;
  },
  saveDraft: (v: AffineBatchPrepared, name: string, requestKey: string) => {
    const prepared = parseAffineBatchPrepared(v);
    if (!name.trim() || name.length > 80) throw new Error('Use a draft name of 1..80 characters.');
    return post('/api/resources', { kind: 'training', name: name.trim(), config: prepared.configuration }, requestKey);
  },
  quote: affinePilotRequests.quote, start: affinePilotRequests.start, task: affinePilotRequests.task, artifact: affinePilotRequests.artifact,
};
/** Single attempts; reuse the same draft/start keys after unknown outcomes. No execution occurs during prepare. */
export function createAffineBatchClient(request: AffinePilotTransport) {
  const generic = createAffinePilotClient(request);
  async function send<T>(d: AffinePilotRequestDescriptor, parse: (v: unknown) => T): Promise<T> {
    let received = false;
    try { const value = await request(d.path, d.init); received = true; return parse(value); }
    catch (error) {
      const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
      if (error instanceof GenerationApiError && (error.code === 'outcome_unknown' || (!received && ['credential_required', 'invalid_route', 'invalid_credential', 'invalid_origin', 'invalid_timeout', 'invalid_range', 'request_too_large'].includes(error.code)))) throw error;
      if (status !== undefined && status >= 400 && status < 500 && status !== 408) throw error;
      throw new GenerationApiError('outcome_unknown', status, new Headers(d.init.headers).get('Idempotency-Key') ?? undefined);
    }
  }
  return {
    prepare: (input: AffineBatchPrepareInput) => send(affineBatchRequests.prepare(input), v => {
      const prepared = parseAffineBatchPrepared(v);
      if (prepared.request.jobExpiresAt <= Date.now() / 1000 || Object.entries(input).some(([k, value]) => prepared.request[k as keyof AffineBatchRequest] !== value)) throw new Error('Batch preparation inputs changed.');
      return prepared;
    }),
    uploadRequest: (v: AffineBatchRequest, filename: string, rightsConfirmed: true) => send(affineBatchRequests.uploadRequest(v, filename, rightsConfirmed), v => {
      if (!record(v) || !record(v.file) || typeof v.file.id !== 'string' || !/^[\w-]{1,64}$/.test(v.file.id)) throw new Error('Invalid uploaded request identity.'); return v;
    }),
    saveDraft: (prepared: AffineBatchPrepared, name: string, requestKey: string) => send(affineBatchRequests.saveDraft(prepared, name, requestKey), v => {
      if (!record(v) || !record(v.resource) || typeof v.resource.id !== 'string' || !/^[\w-]{1,64}$/.test(v.resource.id) || !integer(v.resource.revision, 1) || v.resource.kind !== 'training' || v.resource.name !== name.trim() || !same(v.resource.config, prepared.configuration)) throw new Error('Invalid saved draft identity or configuration.'); return v;
    }),
    quote: generic.quote, start: generic.start, task: generic.task, artifact: generic.artifact,
  };
}
