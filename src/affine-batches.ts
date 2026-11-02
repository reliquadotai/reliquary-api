/** Local preparation only. Full validation requires the official head tokenizer. */
export const AFFINE_BATCH_KIT_REVISION = 'a59734f8a7a494c46df47ca3955cc7f594ec6bc0';
export const AFFINE_BATCH_MAX_BYTES = 64 * 1024 * 1024;
export type AffineBatch = { version: 'affine-batch-v1' | 'affine-batch-v2'; hotkey: string; groups: { prompt: string; rollouts: { output: string; reward: number }[] }[]; train?: { lr?: number; kl?: number } };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function need(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
const exact = (v: unknown, keys: string[]) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const pinnedTrainBounds = { lr: { min: 1.25e-7, max: 1e-6, default: 5e-7 }, kl: { min: 0.005, max: 0.1, default: 0.02 } };
const control = /<\|(?:im_start|im_end|endoftext)\|>/;
const nonblank = (v: unknown): v is string => typeof v === 'string' && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(v);
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
function snapshot(bytes: Uint8Array, limit: number) {
  need(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= limit, 'invalid_byte_limit');
  return new Uint8Array(bytes);
}
function json(bytes: Uint8Array) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new Error('invalid_utf8_json'); }
}
export async function parseAffineMiningContract(bytes: Uint8Array) {
  bytes = snapshot(bytes, 1024 * 1024);
  const v = json(bytes); need(record(v), 'invalid_mining_contract');
  const caps = v.training?.batch_cap, fields = v.batch_file?.train?.fields;
  need(record(caps) && integer(caps.max_tasks_per_miner) && integer(caps.max_rollouts_per_miner) && caps.max_tasks_per_miner <= 125 && caps.max_rollouts_per_miner <= 1000, 'invalid_batch_caps');
  need(typeof v.epoch === 'string' && /^[\w.-]{1,128}$/.test(v.epoch) && hash(v.checkpoint), 'invalid_mining_identity');
  need(Array.isArray(v.batch_file?.formats) && v.batch_file.formats.length <= 2 && v.batch_file.formats.every((f: unknown) => typeof f === 'string' && ['affine-batch-v1', 'affine-batch-v2'].includes(f)) && v.batch_file.formats.includes('affine-batch-v1'), 'invalid_batch_formats');
  const bounds = {} as Record<'lr' | 'kl', { min: number; max: number; default: number }>;
  for (const k of ['lr', 'kl'] as const) {
    const f = fields?.[k]; need(record(f) && finite(f.min) && finite(f.max) && finite(f.default) && f.min > 0 && f.min <= f.default && f.default <= f.max, 'invalid_train_bounds');
    need((['min', 'max', 'default'] as const).every(field => f[field] === pinnedTrainBounds[k][field]), 'unsupported_train_contract');
    bounds[k] = { min: f.min, max: f.max, default: f.default };
  }
  return { sha256: await digest(bytes), epoch: v.epoch, checkpoint: v.checkpoint, maxTasks: caps.max_tasks_per_miner, maxRollouts: caps.max_rollouts_per_miner, formats: v.batch_file.formats as string[], bounds };
}
export async function reviewAffineBatch(bytes: Uint8Array, hotkey: string, miningBytes: Uint8Array) {
  bytes = snapshot(bytes, AFFINE_BATCH_MAX_BYTES);
  const mining = await parseAffineMiningContract(miningBytes);
  const v = json(bytes); need(record(v), 'invalid_batch');
  need(v.version === 'affine-batch-v1' || v.version === 'affine-batch-v2', 'invalid_batch_version');
  const v2 = v.version === 'affine-batch-v2';
  need(exact(v, ['version', 'hotkey', 'groups', ...(v2 && Object.hasOwn(v, 'train') ? ['train'] : [])]), 'invalid_batch_keys');
  need(mining.formats.includes(v.version), 'batch_version_unavailable');
  need(typeof hotkey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(hotkey) && v.hotkey === hotkey, 'hotkey_mismatch');
  const train = { lr: mining.bounds.lr.default, kl: mining.bounds.kl.default };
  if (Object.hasOwn(v, 'train')) {
    need(record(v.train) && Object.keys(v.train).every(k => k === 'lr' || k === 'kl'), 'invalid_train_keys');
    for (const k of ['lr', 'kl'] as const) if (Object.hasOwn(v.train, k)) {
      const n = v.train[k], bound = mining.bounds[k]; need(finite(n) && n >= bound.min && n <= bound.max, 'invalid_train_' + k); train[k] = n;
    }
  }
  need(Array.isArray(v.groups) && v.groups.length > 0, 'invalid_groups');
  const seen = new Set<string>();
  // The official parser checks all structural fields before dropping groups at the cap.
  for (const g of v.groups) {
    need(exact(g, ['prompt', 'rollouts']) && nonblank(g.prompt) && !seen.has(g.prompt), 'invalid_prompt'); seen.add(g.prompt);
    need(Array.isArray(g.rollouts) && g.rollouts.length > 0, 'invalid_rollouts');
    for (const r of g.rollouts) need(exact(r, ['output', 'reward']) && typeof r.output === 'string' && finite(r.reward), 'invalid_rollout');
  }
  let prompts = 0, rollouts = 0;
  for (const g of v.groups) {
    if (prompts === mining.maxTasks || rollouts + g.rollouts.length > mining.maxRollouts) break;
    need(!control.test(g.prompt) && g.rollouts.every((r: any) => !control.test(r.output)), 'forbidden_chat_marker');
    prompts++; rollouts += g.rollouts.length;
  }
  need(prompts > 0, 'first_group_exceeds_cap');
  return { schema: 'affine-batch-review/v1' as const, sha256: await digest(bytes), bytes: bytes.byteLength, format: v.version as AffineBatch['version'],
    prompts, rollouts, droppedGroups: v.groups.length - prompts, train, mining, structuralOnly: true as const, tokenValidation: 'not_run' as const };
}
/** Explicit wire object in, exact serialized bytes out; never edits or truncates the object. */
export async function exportAffineBatch(value: AffineBatch, hotkey: string, miningBytes: Uint8Array) {
  // JSON would silently coerce non-finite rewards and omit undefined properties.
  const text = JSON.stringify(value, function(k, v) { const original = k === '' ? value : this[k]; need(original === v && v !== undefined && !['function', 'symbol', 'bigint'].includes(typeof v) && (typeof v !== 'number' || Number.isFinite(v)), 'non_json_value'); return v; });
  const bytes = new TextEncoder().encode(text + '\n');
  await reviewAffineBatch(bytes, hotkey, miningBytes); return bytes;
}
export type AffineBatchPlanInput = {
  hotkey: string; head: string; reference: string; master: 'provided' | 'bf16-bootstrap'; seed: number;
  prior: 'provided' | 'env-average'; trainingResultAt: number; lastGreenDecidedAt: number;
};
export async function planAffineBatch(bytes: Uint8Array, miningBytes: Uint8Array, input: AffineBatchPlanInput) {
  input = { ...input };
  need(exact(input, ['hotkey', 'head', 'reference', 'master', 'seed', 'prior', 'trainingResultAt', 'lastGreenDecidedAt']), 'invalid_plan_fields');
  need(hash(input.head) && hash(input.reference), 'invalid_descriptor_digest');
  need(['provided', 'bf16-bootstrap'].includes(input.master) && ['provided', 'env-average'].includes(input.prior), 'invalid_plan_mode');
  need(Number.isSafeInteger(input.seed) && input.seed >= 0 && input.seed <= 0xffffffff, 'invalid_seed');
  need(finite(input.trainingResultAt) && finite(input.lastGreenDecidedAt) && input.lastGreenDecidedAt >= 0 && input.trainingResultAt >= input.lastGreenDecidedAt, 'invalid_frozen_clock');
  const review = await reviewAffineBatch(bytes, input.hotkey, miningBytes);
  const commands = ['validate', 'train', 'compare'].map(stage => ({ stage, argv: ['python', '-m', 'reliquary.eval.affine_batches', stage, '--kit', '<KIT>', '--mining', '<MINING>', '--head', '<HEAD>', '--hotkey', input.hotkey, '--work', '<WORK>', '--batch', '<BATCH>',
    ...(stage !== 'validate' ? ['--ref', '<REFERENCE>'] : []), ...(stage === 'train' ? ['--device', 'cpu', '--token-budget', '512', ...(input.master === 'provided' ? ['--master', '<MASTER>'] : [])] : []),
    ...(stage === 'compare' ? ['--candidate', '<CANDIDATE>', '--head-url', '<HEAD_URL>', '--candidate-url', '<CANDIDATE_URL>', '--seed', String(input.seed), '--training-result-at', String(input.trainingResultAt), '--last-green-decided-at', String(input.lastGreenDecidedAt), ...(input.prior === 'provided' ? ['--prior', '<PRIOR>'] : []), '--n', '500', ...(input.master === 'provided' ? ['--master', '<MASTER>'] : [])] : [])] }));
  return { schema: 'affine-batch-plan/v1' as const, upstream: { repository: 'https://github.com/AffineFoundation/affine', revision: AFFINE_BATCH_KIT_REVISION },
    batch: { sha256: review.sha256, bytes: review.bytes, format: review.format, hotkey: input.hotkey }, mining: review.mining,
    head: { digest: input.head, provenance: 'caller-provided-unverified' }, reference: { digest: input.reference, provenance: 'caller-provided-unverified' },
    training: { master: input.master, ...review.train }, comparison: { seed: input.seed, prior: input.prior, trainingResultAt: input.trainingResultAt, lastGreenDecidedAt: input.lastGreenDecidedAt, barZ: Math.max(0.25, 1 - 0.75 * (input.trainingResultAt - input.lastGreenDecidedAt) / 43200) },
    structuralOnly: true, tokenValidation: 'not_run', qualification: 'not_run', liveParity: false, officialAcceptance: false, chainSubmission: false, commands };
}
