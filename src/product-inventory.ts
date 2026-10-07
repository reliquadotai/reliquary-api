export const INVENTORY_KINDS = ['task', 'environment', 'model', 'dataset'] as const;
export type InventoryKind = (typeof INVENTORY_KINDS)[number];
export type InventorySource = {
  id: string;
  name: string;
  state: 'live' | 'stale' | 'unavailable';
  observedAt: string | null;
};
export type InventoryObject = {
  id: string;
  kind: InventoryKind;
  name: string;
  description: string;
  domain: string;
  mechanism: string;
  lifecycle: 'active' | 'retired' | 'qualified' | 'published';
  sourceId: string;
  taskId: string | null;
  modelId: string | null;
  revision: string | null;
  environmentId: string | null;
  datasetId: string | null;
  capabilities: { configure: boolean; order: boolean };
  details: { label: string; value: string }[];
};
export type GenerationSource = {
  id: string;
  name: string;
  prompts_available: number;
  thinking: boolean;
};
export type GenerationCatalog = {
  ordering: 'pilot' | 'disabled';
  any_model_ordering: 'pilot' | 'disabled';
  envs: GenerationSource[];
  models: {
    id: string;
    name: string;
    model?: { repo: string; revision: string };
    price_per_mtok_usd?: number;
    sources: GenerationSource[];
  }[];
};
export type ProductInventory = {
  schemaVersion: 1;
  revision: string;
  fetchedAt: string;
  sources: InventorySource[];
  objects: InventoryObject[];
  generation: GenerationCatalog | null;
};

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 512): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const nullableText = (v: unknown) => v === null || text(v);
const time = (v: unknown): v is string => text(v, 40) && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const unique = (items: { id: string }[]) => new Set(items.map((i) => i.id)).size === items.length;
const repo = (v: unknown): v is string =>
  text(v, 194) && /^[\w.-]+\/[\w.-]+$/.test(v) && !v.includes('..');

export function parseGenerationCatalog(value: unknown): GenerationCatalog {
  const source = (v: unknown): v is GenerationSource =>
    record(v) &&
    text(v['id'], 200) &&
    text(v['name'], 200) &&
    count(v['prompts_available']) &&
    typeof v['thinking'] === 'boolean';
  if (
    !record(value) ||
    !['pilot', 'disabled'].includes(String(value['ordering'])) ||
    !['pilot', 'disabled'].includes(String(value['any_model_ordering'])) ||
    !Array.isArray(value['envs']) ||
    value['envs'].length > 100 ||
    !value['envs'].every(source) ||
    !unique(value['envs']) ||
    !Array.isArray(value['models']) ||
    value['models'].length > 100
  )
    throw new Error('The batch catalogue returned an unexpected response.');
  const models = value['models'].map((m: unknown) => {
    if (
      !record(m) ||
      !text(m['id'], 200) ||
      !text(m['name'], 200) ||
      !Array.isArray(m['sources']) ||
      m['sources'].length > 100 ||
      !m['sources'].every(source) ||
      !unique(m['sources'])
    )
      throw new Error('The batch catalogue returned an unexpected model.');
    const identity = m['model'];
    if (
      identity !== undefined &&
      (!record(identity) || !repo(identity['repo']) || !text(identity['revision'], 128))
    )
      throw new Error('Invalid batch model identity.');
    const price = m['price_per_mtok_usd'];
    if (price !== undefined && (typeof price !== 'number' || !Number.isFinite(price) || price < 0))
      throw new Error('Invalid batch price.');
    return {
      id: m['id'],
      name: m['name'],
      sources: m['sources'],
      ...(record(identity)
        ? { model: { repo: String(identity['repo']), revision: String(identity['revision']) } }
        : {}),
      ...(typeof price === 'number' ? { price_per_mtok_usd: price } : {}),
    };
  });
  if (!unique(models)) throw new Error('The batch catalogue returned duplicate entries.');
  return {
    ordering: value['ordering'] as GenerationCatalog['ordering'],
    any_model_ordering: value['any_model_ordering'] as GenerationCatalog['any_model_ordering'],
    envs: value['envs'],
    models,
  };
}

export function parseProductInventory(value: unknown): ProductInventory {
  if (
    !record(value) ||
    value['schemaVersion'] !== 1 ||
    !text(value['revision'], 64) ||
    !time(value['fetchedAt']) ||
    !Array.isArray(value['sources']) ||
    value['sources'].length > 10 ||
    !Array.isArray(value['objects']) ||
    value['objects'].length > 2000
  )
    throw new Error('The inventory returned an unexpected response.');
  const sources = value['sources'].map((s: unknown): InventorySource => {
    if (
      !record(s) ||
      !text(s['id'], 100) ||
      !text(s['name'], 200) ||
      !['live', 'stale', 'unavailable'].includes(String(s['state'])) ||
      !(s['observedAt'] === null || time(s['observedAt']))
    )
      throw new Error('Invalid inventory source.');
    return {
      id: s['id'],
      name: s['name'],
      state: s['state'] as InventorySource['state'],
      observedAt: s['observedAt'] as string | null,
    };
  });
  if (!unique(sources)) throw new Error('Duplicate inventory source.');
  const objects = value['objects'].map((o: unknown): InventoryObject => {
    if (
      !record(o) ||
      !text(o['id']) ||
      !INVENTORY_KINDS.includes(o['kind'] as InventoryKind) ||
      !['name', 'description', 'domain', 'mechanism', 'sourceId'].every((k) => text(o[k])) ||
      !sources.some((s) => s.id === o['sourceId']) ||
      !['active', 'retired', 'qualified', 'published'].includes(String(o['lifecycle'])) ||
      !['taskId', 'modelId', 'revision', 'environmentId', 'datasetId'].every((k) =>
        nullableText(o[k]),
      ) ||
      !record(o['capabilities']) ||
      typeof o['capabilities']['configure'] !== 'boolean' ||
      typeof o['capabilities']['order'] !== 'boolean' ||
      !Array.isArray(o['details']) ||
      o['details'].length > 16 ||
      !o['details'].every((d: unknown) => record(d) && text(d['label'], 100) && text(d['value']))
    )
      throw new Error('Invalid inventory object.');
    const source = sources.find((s) => s.id === o['sourceId'])!;
    if (o['capabilities']['order'] && (source.state !== 'live' || o['lifecycle'] !== 'qualified'))
      throw new Error('Unqualified inventory cannot allow orders.');
    if (
      o['lifecycle'] === 'retired' &&
      (o['capabilities']['order'] || o['capabilities']['configure'])
    )
      throw new Error('Retired inventory cannot allow configuration.');
    return o as InventoryObject;
  });
  if (!unique(objects)) throw new Error('Duplicate inventory object.');
  return {
    schemaVersion: 1,
    revision: value['revision'],
    fetchedAt: value['fetchedAt'],
    sources,
    objects,
    generation: value['generation'] === null ? null : parseGenerationCatalog(value['generation']),
  };
}
