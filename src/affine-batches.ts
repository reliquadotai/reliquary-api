/** Local preparation only. Full validation requires the official head tokenizer. */
export const AFFINE_BATCH_KIT_REVISION = '46c3cb6a83abbc881341d374e86d438af91eedb5';
export const AFFINE_BATCH_MAX_BYTES = 64 * 1024 * 1024;
export type AffineTrain = { adam_eps?: number; adv_center?: 'mean' | 'none' | 'group_norm'; adv_clip?: number; clamp_mode?: 'per_tensor' | 'global_norm' | 'both'; global_norm_cap?: number; kl?: number; loss_agg?: 'seq_mean' | 'token_mean'; lr?: number; lr_scale_attn?: number; lr_scale_early?: number; lr_scale_embed?: number; lr_scale_late?: number; lr_scale_lm_head?: number; lr_scale_mlp?: number; step_mult?: number; weight_decay?: number };
export type AffineBatch = { version: 'affine-batch-v1' | 'affine-batch-v2'; hotkey: string; groups: { prompt: string; rollouts: { output: string; reward: number }[] }[]; train?: AffineTrain };
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
function need(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
const exact = (v: unknown, keys: string[]) => record(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const integer = (v: unknown): v is number => finite(v) && Number.isSafeInteger(v) && v > 0;
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
type TrainField = { type: string; min?: number; max?: number; default: number | string | null; choices?: (number | string)[] };
const AFFINE_TRAIN_FIELDS: Record<keyof AffineTrain, TrainField> = {
  "adam_eps": {
    "default": 1e-08,
    "max": 0.001,
    "min": 1e-10,
    "type": "number"
  },
  "adv_center": {
    "choices": [
      "mean",
      "none",
      "group_norm"
    ],
    "default": "mean",
    "type": "string"
  },
  "adv_clip": {
    "default": null,
    "max": 100,
    "min": 0.1,
    "type": "number"
  },
  "clamp_mode": {
    "choices": [
      "per_tensor",
      "global_norm",
      "both"
    ],
    "default": "per_tensor",
    "type": "string"
  },
  "global_norm_cap": {
    "default": 1,
    "max": 1,
    "min": 0.005,
    "type": "number"
  },
  "kl": {
    "default": 0.02,
    "max": 0.1,
    "min": 0.005,
    "type": "number"
  },
  "loss_agg": {
    "choices": [
      "seq_mean",
      "token_mean"
    ],
    "default": "seq_mean",
    "type": "string"
  },
  "lr": {
    "default": 5e-07,
    "max": 1e-06,
    "min": 1.25e-07,
    "type": "number"
  },
  "lr_scale_attn": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "lr_scale_early": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "lr_scale_embed": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "lr_scale_late": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "lr_scale_lm_head": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "lr_scale_mlp": {
    "default": 1,
    "max": 2,
    "min": 0,
    "type": "number"
  },
  "step_mult": {
    "choices": [
      1,
      2
    ],
    "default": 1,
    "type": "integer"
  },
  "weight_decay": {
    "default": 0.01,
    "max": 0.05,
    "min": 0,
    "type": "number"
  }
};
const trainKeys = Object.keys(AFFINE_TRAIN_FIELDS) as (keyof AffineTrain)[];
const control = /<\|(?:im_start|im_end|endoftext)\|>/;
const nonblank = (v: unknown): v is string => typeof v === 'string' && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(v);
const digest = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), b => b.toString(16).padStart(2, '0')).join('');
function snapshot(bytes: Uint8Array, limit: number) {
  need(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= limit, 'invalid_byte_limit');
  return new Uint8Array(bytes);
}
function json(bytes: Uint8Array) {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), function(k, v, context?: { source?: string }) {
    // Python's integer contract rejects lexical floats, including 2.0 and 2e0.
    if (k === 'step_mult' && typeof v === 'number') need(!!context?.source && /^-?\d+$/.test(context.source), 'invalid_train_step_mult');
    return v;
  }) as unknown; }
  catch { throw new Error('invalid_utf8_json'); }
}
export async function parseAffineMiningContract(bytes: Uint8Array) {
  bytes = snapshot(bytes, 1024 * 1024);
  const v = json(bytes); need(record(v), 'invalid_mining_contract');
  const caps = v.training?.batch_cap, fields = v.batch_file?.train?.fields;
  need(record(caps) && integer(caps.max_tasks_per_miner) && integer(caps.max_rollouts_per_miner) && caps.max_tasks_per_miner <= 125 && caps.max_rollouts_per_miner <= 1000, 'invalid_batch_caps');
  need(typeof v.epoch === 'string' && /^[\w.-]{1,128}$/.test(v.epoch) && hash(v.checkpoint), 'invalid_mining_identity');
  need(Array.isArray(v.batch_file?.formats) && v.batch_file.formats.length <= 2 && v.batch_file.formats.every((f: unknown) => typeof f === 'string' && ['affine-batch-v1', 'affine-batch-v2'].includes(f)) && v.batch_file.formats.includes('affine-batch-v1'), 'invalid_batch_formats');
  need(record(fields) && Object.keys(fields).length === trainKeys.length && trainKeys.every(k => Object.hasOwn(fields, k)), 'unsupported_train_contract');
  const bounds = {} as Record<keyof AffineTrain, TrainField>;
  for (const k of trainKeys) {
    const f = fields[k], pinned = AFFINE_TRAIN_FIELDS[k];
    need(record(f) && (f.type ?? 'number') === pinned.type && f.default === pinned.default && f.min === pinned.min && f.max === pinned.max && JSON.stringify(f.choices) === JSON.stringify(pinned.choices), 'unsupported_train_contract');
    bounds[k] = { ...pinned, ...(pinned.choices ? { choices: [...pinned.choices] } : {}) };
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
  const train: Record<string, number | string | null> = Object.fromEntries(trainKeys.map(k => [k, mining.bounds[k].default]));
  if (Object.hasOwn(v, 'train')) {
    need(record(v.train) && Object.keys(v.train).every(k => Object.hasOwn(AFFINE_TRAIN_FIELDS, k)), 'invalid_train_keys');
    for (const k of trainKeys) if (Object.hasOwn(v.train, k)) {
      const n = v.train[k], bound = mining.bounds[k];
      need(bound.type === 'string' ? typeof n === 'string' && bound.choices!.includes(n)
        : finite(n) && (bound.type !== 'integer' || Number.isSafeInteger(n)) && (bound.min === undefined || n >= bound.min) && (bound.max === undefined || n <= bound.max) && (!bound.choices || bound.choices.includes(n)), 'invalid_train_' + k);
      train[k] = n;
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
  miningBytes = snapshot(miningBytes, 1024 * 1024);
  need(exact(input, ['hotkey', 'head', 'reference', 'master', 'seed', 'prior', 'trainingResultAt', 'lastGreenDecidedAt']), 'invalid_plan_fields');
  need(hash(input.head) && hash(input.reference), 'invalid_descriptor_digest');
  need(['provided', 'bf16-bootstrap'].includes(input.master) && ['provided', 'env-average'].includes(input.prior), 'invalid_plan_mode');
  need(Number.isSafeInteger(input.seed) && input.seed >= 0 && input.seed <= 0xffffffff, 'invalid_seed');
  need(finite(input.trainingResultAt) && finite(input.lastGreenDecidedAt) && input.lastGreenDecidedAt >= 0 && input.trainingResultAt >= input.lastGreenDecidedAt, 'invalid_frozen_clock');
  const review = await reviewAffineBatch(bytes, input.hotkey, miningBytes);
  const settings = json(snapshot(miningBytes, 1024 * 1024)) as any;
  const round = settings.training?.promotion_gate?.heldout?.current_round;
  const policy = round?.settings;
  const supportedPolicy = {"N": 500, "a_hi": 2, "a_lo": 0.5, "a_shrink": 0.5, "bar_z": 1, "block_delay": 3, "cap": 0.1, "cap_max": 0.33, "cap_rule": "task-level", "floor": 0.1, "head_blocks": 3, "head_rollouts": 12, "k_cand": 8, "max_context_tokens": 16384, "max_tokens": 12288, "min_cover": 0.95, "min_scored": 100, "n_init": 2, "scoring_mode": "separate", "shares": "size", "sigma_run_floor": 0.003, "tau_run": 0, "theta_prior_sd": 2, "weighting": "irt-info", "z_inclusive": false};
  need(record(policy) && round.bar_z === 1 && Object.entries(supportedPolicy).every(([k, v]) => policy[k] === v), 'unsupported_comparison_contract');
  const commands = ['validate', 'train', 'compare'].map(stage => ({ stage, argv: ['python', '-m', 'reliquary.eval.affine_batches', stage, '--kit', '<KIT>', '--mining', '<MINING>', '--head', '<HEAD>', '--hotkey', input.hotkey, '--work', '<WORK>', '--batch', '<BATCH>',
    ...(stage !== 'validate' ? ['--ref', '<REFERENCE>'] : []), ...(stage === 'train' ? ['--device', 'cpu', '--token-budget', '512', ...(input.master === 'provided' ? ['--master', '<MASTER>'] : [])] : []),
    ...(stage === 'compare' ? ['--candidate', '<CANDIDATE>', '--head-url', '<HEAD_URL>', '--candidate-url', '<CANDIDATE_URL>', '--seed', String(input.seed), '--training-result-at', String(input.trainingResultAt), '--last-green-decided-at', String(input.lastGreenDecidedAt), ...(input.prior === 'provided' ? ['--prior', '<PRIOR>'] : []), '--n', '500', ...(input.master === 'provided' ? ['--master', '<MASTER>'] : [])] : [])] }));
  return { schema: 'affine-batch-plan/v1' as const, upstream: { repository: 'https://github.com/AffineFoundation/affine', revision: AFFINE_BATCH_KIT_REVISION },
    batch: { sha256: review.sha256, bytes: review.bytes, format: review.format, hotkey: input.hotkey }, mining: review.mining,
    head: { digest: input.head, provenance: 'caller-provided-unverified' }, reference: { digest: input.reference, provenance: 'caller-provided-unverified' },
    training: { master: input.master, ...review.train }, comparison: { seed: input.seed, prior: input.prior, trainingResultAt: input.trainingResultAt, lastGreenDecidedAt: input.lastGreenDecidedAt, barZ: 1, comparisonClockRule: 'fixed-z-1-public-prior-v1', assurance: 'PUBLIC PRIOR APPROXIMATION', settings: { ...policy } },
    structuralOnly: true, tokenValidation: 'not_run', qualification: 'not_run', liveParity: false, officialAcceptance: false, chainSubmission: false, commands };
}

export * from './affine-batch-pilot.js';
