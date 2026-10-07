export type SubnetTaskManifest = {
  name: string;
  model: string;
  modelRevision: string;
  checkpointSha256: string;
  environment: string;
  environmentSha256: string;
  promptStart: number;
  promptCount: number;
  samplesPerPrompt: number;
  maxNewTokens: number;
  thinking: boolean;
  incentiveCap: number;
  deadlineSeconds: number;
};
export type SubnetCatalog = {
  schemaVersion: 1;
  state: 'disabled' | 'unavailable' | 'available';
  reason: string | null;
  taskPrefix: string;
  poolMax: number;
  models: { id: string; revision: string; checkpointSha256: string; architecture: string }[];
  environments: { id: string; manifestSha256: string }[];
  limits: {
    maxPrompts: number;
    maxSamples: number;
    maxNewTokens: number;
    maxTotalSamples: number;
    maxTotalTokens: number;
    maxCap: number;
    minDeadlineSeconds: number;
    maxDeadlineSeconds: number;
  };
};
export const SUBNET_RUN_STATES = [
  'queued',
  'running',
  'draining',
  'exporting',
  'delivered',
  'cancelled',
  'failed',
] as const;
export type SubnetRun = {
  id: string;
  name: string;
  status: (typeof SUBNET_RUN_STATES)[number];
  revision: string;
  manifestSha256: string;
  manifest: SubnetTaskManifest;
  native: {
    jobId: string;
    taskId: string;
    manifestSha256: string;
    profileSha256: string;
    minerEndpoint: string | null;
  };
  progress: {
    submissions: number;
    verdicts: number;
    settled: number;
    unsettled: number;
    drained: boolean;
  } | null;
  deliveries: { name: string; size: number; sha256: string; url: string }[];
  createdAt: number;
  updatedAt: number;
  reason: string | null;
};
const fail = (): never => {
  throw new Error(
    'The subnet task service returned an invalid response. Refresh and review the task.',
  );
};
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : fail();
const text = (v: unknown, max = 200): string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v)
    ? v
    : fail();
const count = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail();
const number = (v: unknown, min = 0, max = 1): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
const boolean = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail());
const digest = (v: unknown): string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail();
const list = (v: unknown, max: number): unknown[] =>
  Array.isArray(v) && v.length <= max ? v : fail();
const optional = (v: unknown): string | null => (v === null ? null : text(v, 500));
export function subnetMinerEndpoint(value: unknown): string | null {
  try {
    const url = new URL(typeof value === 'string' ? value : '');
    return url.protocol === 'https:' &&
      /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
export function parseSubnetManifest(value: unknown): SubnetTaskManifest {
  const v = record(value);
  const fields = [
    'name',
    'model',
    'modelRevision',
    'checkpointSha256',
    'environment',
    'environmentSha256',
    'promptStart',
    'promptCount',
    'samplesPerPrompt',
    'maxNewTokens',
    'thinking',
    'incentiveCap',
    'deadlineSeconds',
  ];
  if (Object.keys(v).length !== fields.length || fields.some((k) => !Object.hasOwn(v, k))) fail();
  const m = {
    name: text(v['name'], 80),
    model: text(v['model'], 128),
    modelRevision: text(v['modelRevision'], 200),
    checkpointSha256: digest(v['checkpointSha256']),
    environment: text(v['environment'], 128),
    environmentSha256: digest(v['environmentSha256']),
    promptStart: count(v['promptStart']),
    promptCount: count(v['promptCount'], 1, 10000),
    samplesPerPrompt: count(v['samplesPerPrompt'], 1, 16),
    maxNewTokens: count(v['maxNewTokens'], 2, 32768),
    thinking: boolean(v['thinking']),
    incentiveCap: number(v['incentiveCap']),
    deadlineSeconds: count(v['deadlineSeconds'], 60, 86400),
  };
  if (
    !Number.isSafeInteger(m.promptStart + m.promptCount) ||
    m.promptCount * m.samplesPerPrompt > 512 ||
    m.promptCount * m.samplesPerPrompt * m.maxNewTokens > 1048576
  )
    fail();
  return m;
}
export function parseSubnetCatalog(value: unknown): SubnetCatalog {
  const v = record(value),
    limits = record(v['limits']);
  if (
    v['schemaVersion'] !== 1 ||
    !['disabled', 'unavailable', 'available'].includes(String(v['state']))
  )
    fail();
  const models = list(v['models'], 100).map((x) => {
    const m = record(x);
    return {
      id: text(m['id'], 128),
      revision: text(m['revision']),
      checkpointSha256: digest(m['checkpointSha256']),
      architecture: text(m['architecture']),
    };
  });
  const environments = list(v['environments'], 100).map((x) => {
    const e = record(x);
    return { id: text(e['id'], 128), manifestSha256: digest(e['manifestSha256']) };
  });
  if (
    new Set(models.map((m) => m.id)).size !== models.length ||
    new Set(environments.map((e) => e.id)).size !== environments.length
  )
    fail();
  const state = v['state'] as SubnetCatalog['state'],
    reason = optional(v['reason']);
  if (
    (state === 'available') !== (reason === null) ||
    (state === 'available' && (!models.length || !environments.length))
  )
    fail();
  const parsed: SubnetCatalog = {
    schemaVersion: 1,
    state,
    reason,
    taskPrefix: text(v['taskPrefix'], 32),
    poolMax: number(v['poolMax']),
    models,
    environments,
    limits: {
      maxPrompts: count(limits['maxPrompts'], 1, 10000),
      maxSamples: count(limits['maxSamples'], 1, 16),
      maxNewTokens: count(limits['maxNewTokens'], 2, 32768),
      maxTotalSamples: count(limits['maxTotalSamples'], 1, 512),
      maxTotalTokens: count(limits['maxTotalTokens'], 1, 1048576),
      maxCap: number(limits['maxCap']),
      minDeadlineSeconds: count(limits['minDeadlineSeconds'], 60, 86400),
      maxDeadlineSeconds: count(limits['maxDeadlineSeconds'], 60, 86400),
    },
  };
  if (
    parsed.limits.minDeadlineSeconds > parsed.limits.maxDeadlineSeconds ||
    (parsed.state === 'available' && parsed.limits.maxCap > parsed.poolMax)
  )
    fail();
  return parsed;
}
export function parseSubnetRun(value: unknown): SubnetRun {
  const v = record(value),
    manifest = parseSubnetManifest(v['manifest']),
    native = record(v['native']);
  const jobId = text(native['jobId'], 63),
    taskId = text(native['taskId'], 63);
  if (
    ![jobId, taskId].every((id) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) ||
    (native['minerEndpoint'] !== null &&
      subnetMinerEndpoint(native['minerEndpoint']) !== native['minerEndpoint'])
  )
    fail();
  if (
    typeof v['id'] !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v['id']) ||
    !SUBNET_RUN_STATES.includes(v['status'] as SubnetRun['status'])
  )
    fail();
  const p = v['progress'] === null ? null : record(v['progress']);
  const deliveries = list(v['deliveries'], 1000).map((x) => {
    const d = record(x),
      name = text(d['name'], 100),
      url = text(d['url'], 300);
    if (
      !/^[\w.()-]+$/.test(name) ||
      url !== '/api/admin/subnet/tasks/' + v['id'] + '/deliveries/' + name
    )
      fail();
    return { name, size: count(d['size'], 1, 10 * 1024 ** 3), sha256: digest(d['sha256']), url };
  });
  if (
    new Set(deliveries.map((d) => d.name)).size !== deliveries.length ||
    (v['status'] === 'delivered' && !deliveries.length)
  )
    fail();
  const parsed: SubnetRun = {
    id: v['id'] as string,
    name: text(v['name'], 80),
    status: v['status'] as SubnetRun['status'],
    revision: digest(v['revision']),
    manifestSha256: digest(v['manifestSha256']),
    manifest,
    native: {
      jobId,
      taskId,
      manifestSha256: digest(native['manifestSha256']),
      profileSha256: digest(native['profileSha256']),
      minerEndpoint: native['minerEndpoint'] as string | null,
    },
    progress: p
      ? {
          submissions: count(p['submissions']),
          verdicts: count(p['verdicts']),
          settled: count(p['settled']),
          unsettled: count(p['unsettled']),
          drained: boolean(p['drained']),
        }
      : null,
    deliveries,
    createdAt: count(v['createdAt']),
    updatedAt: count(v['updatedAt']),
    reason: optional(v['reason']),
  };
  if (parsed.name !== manifest.name || parsed.updatedAt < parsed.createdAt) fail();
  return parsed;
}
export function parseSubnetRuns(value: unknown): SubnetRun[] {
  const v = record(value);
  const runs = list(v['runs'], 100).map(parseSubnetRun);
  if (new Set(runs.map((run) => run.id)).size !== runs.length) fail();
  return runs;
}
