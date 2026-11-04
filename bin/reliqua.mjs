#!/usr/bin/env node
import { readFile, mkdir, lstat, open, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createPublicClient, createJobsClient, createJobsTransport, jobRequests, OFFICIAL_SKILLS, DEVELOPER_PREVIEW } from '../dist/index.js';
import { affineCommand, UsageError } from './affine-cli.mjs';

const help = `Reliquary developer preview ${DEVELOPER_PREVIEW.version}
Usage: reliqua <command> [options]

  compute list [--gpu TEXT] [--limit 1..100]  Compare public provider offers
  inventory                                Published models and objects
  network                                  Published network observations
  capabilities                             Public product and execution gates
  generation catalog | evaluations catalog Public product discovery
  monitoring health|snapshot                Published observation freshness
  runs list | runs inspect [--run ID]        Public run catalog and telemetry
  doctor                                   Check connectivity and local setup
  jobs capabilities|list|status|events|report  Read owned CPU jobs
  affine review|plan                         Local batch checks; no credential or compute
  affine status|prepare|upload|save-draft|quote|start|task|verify-delivery|download
                                           Qualified Affine batch stages
  skills list [--skill ID] [--search TEXT] [--category ID] [--interface cli|mcp|http] [--access LEVEL]
  skills show --skill ID                    Read packaged instructions
  skills install --directory DIRECTORY [--skill ID]  Install selected or all skills

Options: --json, --origin HTTPS_ORIGIN, --timeout 1..60000 (milliseconds)
Job options: --id ID, --cursor CURSOR, --limit 1..100, --artifact ID
Job reads use RELIQUARY_RESOURCES_KEY (or JOBS_API_KEY).
Affine stages use RELIQUARY_TRAINING_KEY and RELIQUARY_RESOURCES_KEY.
Use --input FILE for one stage, --id ID for task, --directory NEW_DIRECTORY for download.
Local review: --batch FILE --mining FILE --hotkey OWNER; plan: --batch FILE --mining FILE --input FILE.
Upload requires --confirm-rights; start requires --approve-execution and a stable key.
Public reads send no credentials. RELIQUARY_API_URL selects an API origin.
Hosted Affine stages require an owner-qualified profile and upstream grants. No hardware is booked.
--version prints the installed release. --help displays this guide.
`;
const args = process.argv.slice(2);
const json = args.includes('--json');
const fail = message => { throw new UsageError(message); };
const allowed = {
  'compute list': ['gpu', 'limit'], inventory: [], network: [], capabilities: [], doctor: [],
  'jobs capabilities': [], 'jobs list': ['cursor', 'limit'], 'jobs status': ['id'],
  'jobs events': ['id', 'cursor', 'limit'], 'jobs report': ['id', 'artifact'],
  'skills list': ['skill', 'search', 'category', 'interface', 'access'], 'skills show': ['skill'], 'skills install': ['directory', 'skill'],
  'generation catalog': [], 'evaluations catalog': [], 'monitoring health': [], 'monitoring snapshot': [], 'runs list': [], 'runs inspect': ['run'],
  'affine review': ['batch', 'mining', 'hotkey'], 'affine plan': ['batch', 'mining', 'input'],
  'affine status': [], 'affine prepare': ['input'], 'affine upload': ['input', 'confirm-rights'],
  'affine save-draft': ['input'], 'affine quote': ['input'], 'affine start': ['input', 'approve-execution'],
  'affine task': ['id'], 'affine verify-delivery': ['input'], 'affine download': ['input', 'directory'],
};
const clean = value => String(value ?? 'unknown').replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 300);
try {
  if (!args.length || args[0] === '--help' || args[0] === 'help') { process.stdout.write(help); process.exit(0); }
  if (args[0] === '--version') { process.stdout.write(DEVELOPER_PREVIEW.version + '\n'); process.exit(0); }
  const command = ['compute', 'jobs', 'skills', 'generation', 'evaluations', 'monitoring', 'runs', 'affine'].includes(args[0]) ? `${args.shift()} ${args.shift()}` : args.shift();
  if (!Object.hasOwn(allowed, command)) fail('Unknown command. Run reliqua --help.');
  const options = new Map();
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--')) fail('Options must use --name value.');
    const name = flag.slice(2);
    if (!['json', 'origin', 'timeout', ...allowed[command]].includes(name) || options.has(name)) fail('Unknown or repeated option.');
    const value = ['json', 'confirm-rights', 'approve-execution'].includes(name) ? true : args.shift();
    if (value === undefined || (typeof value === 'string' && (!value || value.startsWith('--')))) fail(`--${name} needs a value.`);
    options.set(name, value);
  }
  const required = name => options.has(name) ? options.get(name) : fail(`--${name} is required.`);
  const integer = (name, fallback, max) => {
    if (!options.has(name)) return fallback;
    const text = required(name), n = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(n) || n < 1 || n > max) fail(`--${name} must be 1..${max}.`);
    return n;
  };
  const limit = integer('limit', 20, 100);
  const gpu = options.get('gpu');
  if (gpu && (gpu.length > 80 || /[\x00-\x1f\x7f]/.test(gpu))) fail('--gpu must be a short GPU name.');
  const origin = options.get('origin') ?? process.env.RELIQUARY_API_URL;
  const timeoutMs = integer('timeout', 15_000, 60_000);
  let output;
  let kind = 'json';
  if (command.startsWith('affine ')) {
    output = await affineCommand(command.slice(7), Object.fromEntries(options), {
      origin, timeoutMs,
      apiKey: process.env.RELIQUARY_TRAINING_KEY ?? process.env.TRAINING_API_KEY,
      resourcesApiKey: process.env.RELIQUARY_RESOURCES_KEY ?? process.env.RESOURCES_API_KEY ?? process.env.JOBS_API_KEY,
    });
  } else if (command.startsWith('skills ')) {
    let selectedSkills = options.has('skill') ? OFFICIAL_SKILLS.filter(skill => skill.id === required('skill')) : OFFICIAL_SKILLS;
    if (!selectedSkills.length) fail('Unknown skill ID. Run reliqua skills list.');
    if (command === 'skills list') {
      for (const [name, choices] of [['interface', ['cli', 'mcp', 'http']], ['access', ['public-read', 'authenticated-read', 'approval-required']]])
        if (options.has(name) && !choices.includes(required(name))) fail(`Invalid --${name}.`);
      const search = options.get('search')?.trim().toLowerCase();
      if (options.has('search') && (!search || search.length > 160)) fail('--search must contain 1..160 characters.');
      selectedSkills = selectedSkills.filter(skill =>
        (!search || [skill.id, skill.title, skill.description, ...skill.mcpTools, ...skill.apiRoutes.map(route => route.path)].join(' ').toLowerCase().includes(search)) &&
        (!options.has('category') || skill.category === required('category')) &&
        (!options.has('interface') || skill.interfaces.includes(required('interface'))) &&
        (!options.has('access') || skill.access === required('access')));
      output = { version: DEVELOPER_PREVIEW.version, executionEnabled: false, skills: selectedSkills };
    } else if (command === 'skills show') {
      required('skill');
      const skill = selectedSkills[0];
      const instructions = await readFile(new URL(`../skills/${skill.id}/SKILL.md`, import.meta.url), 'utf8');
      output = { version: DEVELOPER_PREVIEW.version, skill, instructions };
      if (!json) kind = 'instructions';
    } else {
      const directory = resolve(required('directory'));
      await mkdir(directory, { recursive: true });
      const root = await realpath(directory);
      // Preflight every destination before writing any skill.
      const prepared = [];
      for (const skill of selectedSkills) {
        const target = join(root, skill.id);
        try { const info = await lstat(target); if (!info.isDirectory() || info.isSymbolicLink()) fail('A skill destination must be a real directory.'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const path = join(target, 'SKILL.md');
        const content = await readFile(new URL(`../skills/${skill.id}/SKILL.md`, import.meta.url), 'utf8');
        let existing;
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.isSymbolicLink()) fail('Refusing a non-file skill destination.');
          existing = await readFile(path, 'utf8');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (existing !== undefined && existing !== content) fail(`Skill ${skill.id} has local edits. Choose another directory.`);
        prepared.push({ target, path, content, existing });
      }
      for (const item of prepared) {
        if (item.existing !== undefined) continue;
        await mkdir(item.target, { recursive: true });
        const file = await open(item.path, 'wx', 0o644);
        try { await file.writeFile(item.content); } finally { await file.close(); }
      }
      output = { version: DEVELOPER_PREVIEW.version, directory: root, installed: selectedSkills.map(skill => skill.id) };
    }
  } else if (command.startsWith('jobs ')) {
    const page = { limit, ...(options.has('cursor') ? { cursor: required('cursor') } : {}) };
    const action = command.slice(5);
    const method = action === 'status' ? 'detail' : action === 'report' ? 'artifact' : action;
    const parameters = method === 'capabilities' ? [] : method === 'list' ? [page] :
      method === 'events' ? [required('id'), page] : method === 'artifact' ? [required('id'), required('artifact')] : [required('id')];
    try { jobRequests()[method](...parameters); }
    catch { fail('Invalid job identifier, artifact identifier or page cursor. See the Jobs API reference.'); }
    const client = createJobsClient(createJobsTransport({ origin, timeoutMs, apiKey: process.env.RELIQUARY_RESOURCES_KEY ?? process.env.JOBS_API_KEY }).request);
    output = await client[method](...parameters);
  } else {
    const client = createPublicClient({ origin, timeoutMs });
    switch (command) {
      case 'generation catalog': output = await client.generation(); break;
      case 'evaluations catalog': output = await client.read('evaluations'); break;
      case 'monitoring health': output = await client.read('monitoringHealth'); break;
      case 'monitoring snapshot': output = await client.read('monitoringSnapshot'); break;
      case 'runs list': output = await client.read('runs'); break;
      case 'runs inspect': {
        const run = options.get('run');
        if (run !== undefined && (!/^[a-zA-Z0-9_.-]{1,128}$/.test(run) || run === '.' || run === '..')) fail('Choose an ID from runs list.');
        output = await client.run(run); break;
      }
      case 'inventory': output = await client.inventory(); kind = 'inventory'; break;
      case 'network': output = await client.read('network'); break;
      case 'compute list': {
        const catalog = await client.compute();
        const matches = catalog.offers.filter(offer => !gpu || offer.gpu.toLowerCase().includes(gpu.toLowerCase()));
        output = { ...catalog, offers: matches.slice(0, limit), matchingOffers: matches.length,
          executionEnabled: false, notice: 'Provider observations only. This preview cannot book or manage rentals. Check source and offer timestamps; providers confirm final availability and terms.' };
        kind = 'compute'; break;
      }
      case 'capabilities': {
        const [readiness, generation, evaluations, compute] = await Promise.all([
          client.read('readiness'), client.generation(), client.read('evaluations'), client.compute(),
        ]);
        output = { preview: DEVELOPER_PREVIEW, readiness, generation, evaluations,
          compute: { managedRentalsEnabled: compute['managedRentalsEnabled'] ?? null, rehearsalEnabled: compute['rehearsalEnabled'] ?? null },
          notice: 'Public service state is separate from account permission and qualified capacity. Affine stages require a qualified owner profile and explicit upload/launch approval.' };
        break;
      }
      case 'doctor': {
        const health = await client.read('health');
        output = { version: DEVELOPER_PREVIEW.version, apiOrigin: new URL(origin ?? DEVELOPER_PREVIEW.apiOrigin).origin,
          health, resourcesCredentialConfigured: !!(process.env.RELIQUARY_RESOURCES_KEY ?? process.env.JOBS_API_KEY),
          trainingCredentialConfigured: !!(process.env.RELIQUARY_TRAINING_KEY ?? process.env.TRAINING_API_KEY),
          credentialValidated: false,
          execution: { automatic: false, affineStagesSupported: true, qualifiedOwnerProfileRequired: true, explicitLaunchApprovalRequired: true, availability: 'not_checked' },
          nextStep: 'For Affine batches, set your training key locally and run reliqua affine status --json. For owned CPU jobs, set a resources key and run reliqua jobs capabilities. Account permission does not establish capacity.' };
      }
    }
  }
  if (kind === 'instructions') process.stdout.write(output.instructions);
  else if (!json && kind === 'compute') {
    process.stdout.write('Provider observations · no booking or execution\n');
    process.stdout.write('Provider\tGPU\tGPUs/package\tUSD/package-hour\tObserved\n');
    for (const offer of output.offers) process.stdout.write([offer.provider, offer.gpu, offer.gpuCount, (offer.priceMicroUsdPerHour / 1_000_000).toFixed(4), offer.observedAt ?? 'unknown'].map(clean).join('\t') + '\n');
    process.stdout.write(`${output.offers.length} shown / ${output.matchingOffers} matching. Snapshot: ${clean(output.observedAt)}\n`);
    process.stdout.write('Source states:\n' + JSON.stringify(output.sources, null, 2) + '\n' + output.notice + '\n');
  } else if (!json && kind === 'inventory') {
    process.stdout.write('Published inventory · source publication does not qualify execution\n');
    for (const item of output.objects) process.stdout.write([item.kind, item.name, item.lifecycle, item.sourceId].map(clean).join('\t') + '\n');
    process.stdout.write('Sources:\n' + JSON.stringify(output.sources, null, 2) + '\n');
  } else process.stdout.write(JSON.stringify(output, null, json ? undefined : 2) + '\n');
} catch (error) {
  const code = error instanceof UsageError ? error.code : typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code : 'command_failed';
  const guidance = error instanceof UsageError ? error.message : 'Check the API origin, connection and required scope. No request was retried. Run reliqua --help.';
  process.stderr.write(JSON.stringify({ error: { code, message: guidance,
    ...(error?.status === undefined ? {} : { status: error.status }),
    ...(error?.requestId === undefined ? {} : { requestId: error.requestId }),
    ...(error?.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }),
    ...(typeof error?.retryKey === 'string' && /^[\w-]{16,80}$/.test(error.retryKey) ? { retryKey: error.retryKey } : {}),
  } }) + '\n');
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
