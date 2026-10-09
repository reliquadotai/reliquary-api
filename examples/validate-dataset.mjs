import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createJobsClient, createJobsTransport, jobUuid } from '../dist/job-api.js';

// Supply retained UUIDs before running; an ambiguous mutation must keep its original key.
const inputKey = jobUuid(process.env.INPUT_REQUEST_KEY);
const jobKey = jobUuid(process.env.JOB_REQUEST_KEY);
if (inputKey === jobKey) throw new Error('Use distinct retained UUIDs for upload and submission.');
if (!process.env.JOBS_API_KEY || !process.argv[2]) throw new Error('Supply JOBS_API_KEY and a JSONL file.');
const file = process.argv[2];
const info = await stat(file);
if (!info.isFile() || info.size < 1 || info.size > 32768) throw new Error('Input must be a file of 1..32768 bytes.');
const bytes = await readFile(file);
if (bytes.length < 1 || bytes.length > 32768) throw new Error('Input must be 1..32768 bytes.');
const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const format = process.env.JOBS_DATASET_FORMAT ?? 'instruction';
const jobs = createJobsClient(createJobsTransport({ apiKey: process.env.JOBS_API_KEY, origin: process.env.JOBS_API_ORIGIN }).request);
const capability = (await jobs.capabilities()).workloads.find(workload => workload.kind === 'dataset_validation');
if (!capability?.can_submit) throw new Error(capability?.reason ?? 'CPU validation is unavailable.');

const input = await jobs.uploadInput({ schema_version: 1, format, content }, inputKey);
const created = await jobs.create({ schema_version: 1, spec: {
  kind: 'dataset_validation', input, limits: { deadline_seconds: 300, max_attempts: 2 },
} }, jobKey);
process.stderr.write(JSON.stringify({ job_id: created.id, input_request_key: inputKey, job_request_key: jobKey }) + '\n');

// The read deadline does not cancel a job or cause another submission.
const signal = AbortSignal.timeout(90_000);
let job = created;
while (['queued', 'running', 'cancelling'].includes(job.state)) {
  await delay(3000, undefined, { signal });
  job = await jobs.detail(created.id, signal);
}
if (job.state !== 'succeeded') throw new Error(`Job ${created.id} is ${job.state}; inspect its state before taking another action.`);
const artifact = job.artifacts.find(item => item.kind === 'validation_report');
if (!artifact) throw new Error('The completed job has no validation report.');
const result = await jobs.artifact(created.id, artifact.id, signal);
if (result.report.input_sha256 !== input.sha256 || result.report.format !== input.format)
  throw new Error('The verified report does not match the submitted input.');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
process.exitCode = result.report.valid ? 0 : 1;
