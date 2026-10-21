import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalEvaluationJson, parseEvaluationQuoteInput, assertEvaluationQuoteMatches,
  createEvaluationClient, createEvaluationTransport, parseEvaluationReport, parseEvaluationProtocolJson,
} from '../dist/index.js';

const hash = text => createHash('sha256').update(text).digest('hex');
const equal = (a, b) => canonicalEvaluationJson(a) === canonicalEvaluationJson(b);
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
const safeRef = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+=@-]{0,109}$/.test(value);
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export function parseCheckpointConfig(value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'A checkpoint configuration is required.');
  requireValue(Object.keys(value).every(k => ['schema_version', 'trainer_run_id', 'checkpoint_step', 'client_ref', 'max_total_usd', 'requests'].includes(k)), 'Unknown configuration field.');
  requireValue(value.schema_version === 1 && safeRef(value.trainer_run_id) && safeRef(value.client_ref), 'Use schema_version1 and safe trainer_run_id/client_ref identifiers.');
  requireValue(Number.isSafeInteger(value.checkpoint_step) && value.checkpoint_step >= 0 && value.checkpoint_step <= 1e12, 'An explicit optimizer checkpoint_step in0..1e12 is required.');
  requireValue(typeof value.max_total_usd === 'number' && Number.isFinite(value.max_total_usd) && value.max_total_usd >= 0, 'An explicit approved max_total_usd is required.');
  requireValue(Array.isArray(value.requests) && value.requests.length >= 1 && value.requests.length <= 8, 'Choose1..8 fixed-set evaluation requests.');
  const requests = value.requests.map(input => {
    const parsed = parseEvaluationQuoteInput(input);
    requireValue(parsed.mode === 'direct', 'Frozen checkpoint evaluations currently require explicitly qualified direct mode.');
    requireValue(parsed.envs.length === 1 && typeof parsed.sampling?.seed === 'number', 'Each request needs one explicit set_id and sampling.seed.');
    requireValue(typeof parsed.harness === 'string' && Number.isSafeInteger(parsed.max_turns) && Number.isSafeInteger(parsed.max_episode_tokens) && Number.isSafeInteger(parsed.episode_timeout_seconds), 'Pin harness, max_turns, max_episode_tokens and episode_timeout_seconds explicitly.');
    return structuredClone(parsed);
  });
  requireValue(requests.every(r => r.model === requests[0].model && r.revision === requests[0].revision), 'One journal may evaluate exactly one model checkpoint.');
  requireValue(new Set(requests.map(r => r.envs[0].set_id)).size === requests.length, 'Each fixed set may appear once.');
  return { ...value, requests };
}

export async function writeJournal(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function withJournalLock(path, action) {
  const parent = await stat(dirname(path));
  requireValue((parent.mode & 0o077) === 0 && parent.isDirectory(), 'Keep journals in an owner-only directory outside source repositories.');
  let lock;
  try { lock = await open(`${path}.lock`, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Journal is locked. Confirm its previous process stopped before removing its stale .lock file.'); throw error; }
  try { await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); await lock.sync(); return await action(); }
  finally { await lock.close(); await unlink(`${path}.lock`); }
}

export async function boundedRead(read, { signal, attempts = 5, sleep = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await read(); }
    catch (error) {
      const transient = [408, 429, 500, 502, 503, 504].includes(error?.status) || ['upstream_unavailable', 'request_aborted'].includes(error?.code);
      if (!transient || attempt + 1 >= attempts || signal?.aborted) throw error;
      const milliseconds = error.retryAfterSeconds === undefined ? Math.min(4000, 250 * 2 ** attempt) : error.retryAfterSeconds * 1000;
      await sleep(milliseconds, undefined, { signal });
    }
  }
}

function verifyProtocol(object, raw, digest) {
  requireValue(object && typeof raw === 'string' && /^[a-f0-9]{64}$/.test(digest), 'A qualified frozen protocol is required.');
  requireValue(hash(Buffer.from(raw, 'utf8')) === digest && equal(parseEvaluationProtocolJson(raw), object), 'Frozen protocol bytes or digest changed.');
}

function verifiedSet(catalog, input) {
  const selected = input.envs[0];
  const set = catalog.envs.find(e => e.env === selected.env)?.sets.find(s => s.set_id === selected.set_id);
  requireValue(set?.qualified_support === true && selected.problems <= set.count, 'The fixed qualified set is unavailable.');
  verifyProtocol(set.protocol, set.protocol_json, set.protocol_sha256);
  requireValue(set.protocol.schema === 'reliquary/evaluation-protocol/v1' && set.protocol.set?.set_id === selected.set_id && set.protocol.set?.count === set.count, 'Set protocol identity changed.');
  requireValue(set.protocol.harness?.id === input.harness && input.max_turns <= set.protocol.harness?.max_turns, 'The frozen source does not qualify this harness or turn budget.');
  return set;
}

function assertFrozenQuote(quote, input, set) {
  assertEvaluationQuoteMatches(quote, input);
  verifyProtocol(quote.protocol, quote.protocol_json, quote.protocol_sha256);
  const expected = {
    schema: 'reliquary/evaluation-request/v1', sets: input.envs,
    protocol_bindings: { [set.set_id]: set.protocol_sha256 }, sampling: quote.sampling,
    thinking: input.thinking ?? false, max_new_tokens: input.max_new_tokens, harness: input.harness,
    max_turns: input.max_turns, max_episode_tokens: input.max_episode_tokens,
    episode_timeout_seconds: input.episode_timeout_seconds,
    interaction: quote.protocol.interaction,
  };
  requireValue(typeof expected.interaction === 'string' && equal(expected, quote.protocol) && equal(quote.protocol_bindings, expected.protocol_bindings), 'The quote does not bind the exact frozen evaluation protocol.');
}

function assertOrder(order, entry) {
  requireValue(order.quote_id === entry.quote.quote_id && order.client_ref === entry.client_ref, 'Receipt quote or client reference changed.');
  for (const key of ['model', 'model_access', 'mode', 'envs', 'sampling', 'thinking', 'max_new_tokens', 'harness', 'max_turns', 'max_episode_tokens', 'episode_timeout_seconds', 'protocol', 'protocol_json', 'protocol_sha256', 'protocol_bindings'])
    requireValue(equal(order[key], entry.quote[key]), `Receipt ${key} does not match the retained quote.`);
}

export async function downloadEvaluationReport(transport, order, signal, sleep = delay) {
  const file = order.files?.find(f => f.name === 'report.json');
  requireValue(file && /^[a-f0-9]{64}$/.test(file.sha256) && file.size > 0 && file.size <= MAX_REPORT_BYTES, 'A bounded digest-pinned report is required.');
  const bytes = Buffer.alloc(file.size);
  for (let offset = 0; offset < file.size;) {
    const maxBytes = Math.min(262144, file.size - offset);
    const chunk = await boundedRead(() => transport.download(order.id, file.name, { offset, maxBytes }, signal), { signal, sleep });
    requireValue(chunk.bytes.byteLength === maxBytes, 'The report download is incomplete.');
    bytes.set(chunk.bytes, offset); offset += chunk.bytes.byteLength;
  }
  requireValue(hash(bytes) === file.sha256, 'The report digest does not match its delivery receipt.');
  const report_json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { report: parseEvaluationReport(JSON.parse(report_json), order), report_json };
}

/** A rerun reads retained receipts first. Only explicit confirm can send a retained POST. */
export async function runCheckpointEvaluation(configValue, options) {
  const config = parseCheckpointConfig(configValue);
  const intent = value => { const { max_total_usd, ...request } = value; return request; };
  const configHash = hash(canonicalEvaluationJson(intent(config)));
  const { journalPath, client, transport, credentialContext, confirm = false, sleep = delay, waitSeconds = 90, maxPolls = 30 } = options;
  requireValue(typeof credentialContext === 'string' && /^[a-f0-9]{64}$/.test(credentialContext), 'Bind the journal to its API origin and credential fingerprint.');
  requireValue(Number.isSafeInteger(waitSeconds) && waitSeconds >= 0 && waitSeconds <= 3600 && Number.isSafeInteger(maxPolls) && maxPolls >= 1 && maxPolls <= 120, 'Invalid bounded polling limits.');
  return withJournalLock(journalPath, async () => {
    let state;
    try {
      const info = await stat(journalPath);
      requireValue(info.isFile() && (info.mode & 0o077) === 0 && info.size <= 80 * 1024 * 1024, 'Journal must be a bounded owner-only file.');
      state = JSON.parse(await readFile(journalPath, 'utf8'));
      requireValue(state.schema_version === 1 && state.config_sha256 === configHash && equal(intent(state.config), intent(config)) && state.credential_context === credentialContext, 'This journal belongs to a different checkpoint, configuration or API credential.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = { schema_version: 1, config_sha256: configHash, credential_context: credentialContext, config, created_at: Date.now(), entries: config.requests.map((input, index) => ({ input, client_ref: `${config.client_ref}:${index}`, request_key: randomUUID(), phase: 'prepared', quote: null, order_id: null, result: null })) };
      await writeJournal(journalPath, state);
    }
    requireValue(Array.isArray(state.entries) && state.entries.length === config.requests.length, 'Journal evaluation coverage changed.');
    state.entries.forEach((entry, index) => {
      requireValue(equal(entry.input, config.requests[index]) && entry.client_ref === `${config.client_ref}:${index}` && /^[a-f0-9-]{36}$/.test(entry.request_key), 'Journal confirmation identity changed.');
      if (entry.quote) { verifyProtocol(entry.set.protocol, entry.set.protocol_json, entry.set.protocol_sha256); assertFrozenQuote(entry.quote, entry.input, entry.set); }
    });
    const save = () => writeJournal(journalPath, state);
    const signal = AbortSignal.timeout(Math.max(15000, waitSeconds * 1000));
    // Reconciliation never depends on the current catalog or a new quote.
    for (const entry of state.entries) {
      if (!entry.quote || entry.order_id) continue;
      const result = await boundedRead(() => client.orders({ quote_id: entry.quote.quote_id, client_ref: entry.client_ref }, signal), { signal, sleep });
      requireValue(result.evaluations.length <= 1, 'Multiple receipts match this original confirmation; operator reconciliation is required.');
      if (result.evaluations.length) { assertOrder(result.evaluations[0], entry); entry.order_id = result.evaluations[0].id; entry.phase = 'ordered'; await save(); }
    }
    let catalog;
    if (state.entries.some(entry => !entry.quote)) catalog = await boundedRead(() => client.catalog(signal), { signal, sleep });
    for (const entry of state.entries) {
      if (entry.quote) continue;
      requireValue(entry.phase === 'prepared', 'Quote acknowledgement is unknown; this journal will not automatically requote. No order confirmation was sent.');
      requireValue(catalog.ordering === 'pilot', 'Evaluation ordering is unavailable.');
      const set = verifiedSet(catalog, entry.input);
      entry.phase = 'quoting'; await save();
      const quote = await client.quote(entry.input, signal);
      assertFrozenQuote(quote, entry.input, set);
      entry.quote = quote; entry.set = set; entry.phase = 'quoted'; await save();
    }
    const total = state.entries.reduce((sum, e) => sum + Math.round(e.quote.price_usd * 1e6), 0);
    requireValue(Number.isSafeInteger(total), 'Quoted total exceeds the supported cost limit.');
    if (state.approval) requireValue(state.approval.max_total_usd === config.max_total_usd && equal(state.approval.quote_ids, state.entries.map(e => e.quote.quote_id)), 'An attempted confirmation must retain its original exact quote approval and ceiling.');
    if (confirm) {
      requireValue(total <= Math.floor(config.max_total_usd * 1e6), 'Quoted total exceeds the explicitly approved cost ceiling.');
      state.config.max_total_usd = config.max_total_usd;
      state.approval ??= { quote_ids: state.entries.map(e => e.quote.quote_id), max_total_usd: config.max_total_usd, approved_at: Date.now() };
      await save();
    }
    for (const entry of state.entries) {
      if (entry.order_id || !confirm) continue;
      requireValue(Date.parse(entry.quote.expires_at) > Date.now(), 'The retained quote expired. Reconcile the original receipt; this journal will not requote or change its key.');
      // These exact values are durable before the financial request is sent.
      entry.phase = 'submitting'; entry.submitted_at = Date.now(); await save();
      try {
        const order = await client.create(entry.quote.quote_id, entry.request_key, entry.client_ref);
        assertOrder(order, entry); entry.order_id = order.id; entry.phase = 'ordered'; await save();
      } catch (error) {
        entry.phase = 'confirmation_unresolved';
        entry.last_error = { code: typeof error.code === 'string' ? error.code : 'invalid_receipt', status: error.status ?? null, request_id: error.requestId ?? null, retry_after_seconds: error.retryAfterSeconds ?? null };
        await save(); throw error;
      }
    }
    try { for (let poll = 0; poll < maxPolls; poll++) {
      let pending = false;
      for (const entry of state.entries) {
        if (!entry.order_id || entry.result) continue;
        const order = await boundedRead(() => client.detail(entry.order_id, signal), { signal, sleep });
        assertOrder(order, entry); entry.status = order.status; await save();
        if (order.status === 'delivered') {
          const verified = await downloadEvaluationReport(transport, order, signal, sleep);
          entry.result = { order, ...verified, verified_at: Date.now(), report_sha256: order.files.find(f => f.name === 'report.json').sha256 };
          entry.phase = 'delivered'; await save();
        } else if (!['cancelled', 'failed'].includes(order.status)) pending = true;
      }
      if (!pending || waitSeconds === 0) break;
      try { await sleep(3000, undefined, { signal }); }
      catch (error) { if (!signal.aborted) throw error; break; }
    } } catch (error) { if (!signal.aborted) throw error; }
    return state;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), confirm = args.includes('--confirm');
    const rest = args.filter(arg => arg !== '--confirm');
    requireValue(rest.length === 2 && args.filter(arg => arg === '--confirm').length <= 1, 'Usage: node examples/evaluate-checkpoint.mjs CONFIG.json STATE.private.json [--confirm]');
    requireValue(process.env.EVALUATIONS_API_KEY, 'EVALUATIONS_API_KEY is required.');
    const configInfo = await stat(rest[0]);
    requireValue(configInfo.isFile() && configInfo.size >= 1 && configInfo.size <= 65536, 'Configuration must be a JSON file of1..65536bytes.');
    const config = JSON.parse(await readFile(rest[0], 'utf8'));
    const transport = createEvaluationTransport({ apiKey: process.env.EVALUATIONS_API_KEY, origin: process.env.EVALUATIONS_API_ORIGIN, timeoutMs: 15000 });
    const origin = new URL(process.env.EVALUATIONS_API_ORIGIN ?? 'https://api.reliqua.ai').origin;
    const credentialContext = hash(canonicalEvaluationJson({ origin, credential_sha256: hash(process.env.EVALUATIONS_API_KEY) }));
    const state = await runCheckpointEvaluation(config, { journalPath: resolve(rest[1]), credentialContext, client: createEvaluationClient(transport.request), transport, confirm });
    process.stdout.write(JSON.stringify({ schema_version: 1, checkpoint_step: state.config.checkpoint_step, model: { repo: state.config.requests[0].model, revision: state.config.requests[0].revision }, quoted_total_usd: state.entries.reduce((n, e) => n + e.quote.price_usd, 0), evaluations: state.entries.map(entry => ({ id: entry.order_id, client_ref: entry.client_ref, quote_id: entry.quote?.quote_id, price_usd: entry.quote?.price_usd, quote_expires_at: entry.quote?.expires_at, phase: entry.phase, status: entry.status ?? null, complete: entry.result?.order.complete ?? null, protocol_sha256: entry.quote?.protocol_sha256, metrics: entry.result?.report.envs ?? null, files: entry.result?.order.files ?? [] })) }, null, 2) + '\n');
    if (state.entries.some(entry => !entry.result)) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({ error: error.code ?? 'checkpoint_evaluation_failed', message: error.code ? 'Inspect the retained journal and original confirmation before retrying.' : error.message, status: error.status ?? null, request_id: error.requestId ?? null, retry_key: error.retryKey ?? null }) + '\n');
    process.exitCode = 1;
  }
}
