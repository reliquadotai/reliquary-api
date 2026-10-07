#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises';
import { createJobsClient, createJobsTransport, parseJobCreateInput, validateJobDatasetContent, WORKLOAD_DEFINITIONS } from '../dist/index.js';

const help = `Usage: jobctl <definitions|capabilities|list|status|events|report|upload|submit|pause|resume|cancel> [options]

Read commands: list [--cursor VALUE] [--limit 1..100], status/events --id JOB_ID,
report --id JOB_ID --artifact ARTIFACT_ID.
Writes require --confirm --request-key UUID. Upload uses --file DATA.jsonl --format
instruction|preference|corpus. Submit uses --file SPEC.json containing
{"schema_version":1,"spec":{"kind":"dataset_validation","input":{...},"limits":{...}}}.
Controls require --id JOB_ID --revision REVISION --reason "Reviewed reason".
Credentials: JOBS_API_KEY environment variable. Optional JOBS_API_ORIGIN.
Mutations are sent once. Preserve the original request key and input to reconcile
an unknown outcome. Worker enrollment and administrator wallet actions are separate.
`;
const args = process.argv.slice(2);
if (!args.length || args[0] === 'help' || args[0] === '--help') { process.stdout.write(help); process.exit(0); }
const command = args.shift();
const writes = ['upload', 'submit', 'pause', 'resume', 'cancel'];
const permitted = {
  definitions: [], capabilities: [], list: ['cursor', 'limit'], status: ['id'], events: ['id', 'cursor', 'limit'], report: ['id', 'artifact'],
  upload: ['file', 'format', 'request-key', 'confirm'], submit: ['file', 'request-key', 'confirm'],
  pause: ['id', 'revision', 'reason', 'request-key', 'confirm'], resume: ['id', 'revision', 'reason', 'request-key', 'confirm'], cancel: ['id', 'revision', 'reason', 'request-key', 'confirm'],
};
const options = new Map();
try {
  if (!Object.hasOwn(permitted, command)) throw new Error('Unknown command. Use jobctl --help.');
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !permitted[command].includes(flag.slice(2)) || options.has(flag.slice(2))) throw new Error('Invalid or repeated option.');
    const key = flag.slice(2), value = key === 'confirm' ? true : args.shift();
    if (value === undefined || (typeof value === 'string' && value.startsWith('--'))) throw new Error('An option value is missing.');
    options.set(key, value);
  }
  const required = name => { const value = options.get(name); if (typeof value !== 'string' || !value) throw new Error(`--${name} is required.`); return value; };
  if (writes.includes(command) && options.get('confirm') !== true) throw new Error('Review the input and explicitly pass --confirm before submitting a mutation.');
  const file = async () => {
    const path = required('file'), info = await stat(path);
    if (!info.isFile() || info.size < 1 || info.size > 32768) throw new Error('Input must be a file of 1..32768 bytes.');
    const data = await readFile(path);
    if (data.length > 32768) throw new Error('Input exceeds 32768 bytes.');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  };
  if (command === 'definitions') { process.stdout.write(JSON.stringify(WORKLOAD_DEFINITIONS, null, 2) + '\n'); process.exit(0); }
  const transport = createJobsTransport({ apiKey: process.env.JOBS_API_KEY, origin: process.env.JOBS_API_ORIGIN });
  const client = createJobsClient(transport.request);
  const page = () => ({ ...(options.has('cursor') ? { cursor: required('cursor') } : {}), ...(options.has('limit') ? { limit: Number(required('limit')) } : {}) });
  let output;
  switch (command) {
    case 'capabilities': output = await client.capabilities(); break;
    case 'list': output = await client.list(page()); break;
    case 'status': output = await client.detail(required('id')); break;
    case 'events': output = await client.events(required('id'), page()); break;
    case 'report': output = await client.artifact(required('id'), required('artifact')); break;
    case 'upload': {
      const content = await file(), format = required('format');
      await validateJobDatasetContent(content, format);
      output = await client.uploadInput({ schema_version: 1, format, content }, required('request-key'));
      break;
    }
    case 'submit': {
      const text = await file();
      let input;
      try { input = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error('The request file must contain valid JSON.'); }
      output = await client.create(parseJobCreateInput(input), required('request-key'));
      break;
    }
    default: output = await client.control(required('id'), command, { schema_version: 1, revision: required('revision'), reason: required('reason') }, required('request-key'));
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 'outcome_unknown') {
    process.stderr.write(JSON.stringify({ error: 'outcome_unknown', request_key: options.get('request-key'), revision: options.get('revision') ?? null, action: command, guidance: 'Reconcile status with the original input and key; do not create a new key to retry.' }) + '\n');
  } else process.stderr.write((code ? `Job API refused the request: ${code}.` : error instanceof Error ? error.message : 'Job command failed.') + '\n');
  process.exitCode = 1;
}
