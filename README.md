# API contracts and clients

Source candidate `@reliquary/api` 0.12.0 contains versioned generation, job and evaluation contracts, runtime validators, TypeScript clients and bounded fetch transports. It is for customer integrations and the platform's existing browser transport. It does not provision capacity or enable services.

Use the [public HTTP reference](https://app.reliqua.ai/docs/api-reference/overview) for current platform routes and access requirements. Use the [contract index](contracts/README.md) for this package's exact OpenAPI files, exports and coverage. The source is [MIT licensed](LICENSE). Install a reviewed source build or local tarball; the manifest retains `private: true` to prevent npm registry publication. Security reports use the private channels described in [SECURITY.md](SECURITY.md).

## Start here

| Need | Reference |
| --- | --- |
| Base URL, credentials, installed version and availability | [Connection and version boundaries](#connection-and-version-boundaries) |
| Generate datasets from a catalogue or pinned model | [Generation](#generation) |
| Upload and validate an owned dataset | [Jobs](#jobs), [CPU quickstart](#cpu-quickstart), [CLI](#cli) |
| Compare exact model checkpoints on frozen sets | [Pinned checkpoint evaluations](#pinned-checkpoint-evaluations) |
| Export approved, verified benchmark results | [Approved benchmark publication](#approved-benchmark-publication) |
| Request/response schemas and audience-specific paths | [Contract index](contracts/README.md) |

## Customer developer preview

The package also ships the lightweight `reliqua` CLI and 45 official task-oriented skills. Node.js 22 or later is required. From a reviewed source checkout:

```sh
npm ci
npm test
npm pack
```

This produces `reliquary-api-0.12.0.tgz`. Record and verify its checksum when handing off the reviewed artifact. Install that local tarball for the CLI:

```sh
npm install --global ./reliquary-api-0.12.0.tgz
reliqua doctor
reliqua compute list --gpu H200 --limit 20 --json
reliqua inventory --json
reliqua network --json
reliqua generation catalog --json
reliqua evaluations catalog --json
reliqua monitoring health --json
reliqua runs list --json
reliqua runs inspect --json
reliqua capabilities --json
reliqua skills list --search "tokens" --category observability --json
reliqua skills show --skill reliquary-run-token-mix
reliqua skills install --skill reliquary-compute --directory "$HOME/.agents/skills"
```

Public reads use the existing APIs without sending credentials. `createPublicClient` provides the same fixed public GET routes with bounded responses and deadlines; it never follows redirects or retries. `OFFICIAL_SKILLS` supplies the shared workflow manifest: categories, supported interfaces, access requirements, support states, actual tool sequences, HTTP routes and task guidance. Skills cover public discovery, owned reads and gated preparation/execution workflows; installing instructions never enables capabilities or authorizes execution. Each skill's `state` is `available`, `qualified-pilot`, `gated` or `not-yet-available`. `not-yet-available` marks a workflow whose product is not open yet (catalog/environment generation, private training, CPU validation and the Affine workflows in this release): its instructions ship unchanged for when it opens, `availability` and the first line of its SKILL.md say what to use instead, and `reliqua skills list --state not-yet-available` lists them. Use `skills install --skill ID` to install one workflow, or omit `--skill` for the entire catalog. Public commands remain read-only. The explicitly selected `affine` batch stages can upload metadata, save a draft and launch only an approved owner-qualified profile; data rights and execution require separate CLI flags. No command provisions hardware or retries a mutation. Existing `jobctl` functionality and API wire contracts remain unchanged.

For owned job reads, set `RELIQUARY_RESOURCES_KEY` privately in your environment (`JOBS_API_KEY` is also supported), then use `reliqua jobs capabilities`, `list`, `status`, `events` or `report`. Run `reliqua --help` for required arguments. `doctor` reports configured credentials without claiming to validate them. Account permission and qualified worker availability are separate.

Use `--json` for machine output. Errors are structured JSON on stderr with safe request diagnostics. Exit codes are 0 for a successful read (including empty/unavailable catalogs), 1 for a failed command/request and 2 for invalid arguments. `--origin`/`RELIQUARY_API_URL` support HTTPS origins and loopback HTTP; `--timeout` is a bounded request deadline in milliseconds. Skill installation is repeatable and refuses to overwrite local edits or symlink destinations. Remove the chosen skill folders separately; `npm uninstall --global @reliquary/api` removes the client.

This 0.12.0 source candidate ships matching bundled instructions; repository visibility, hosted release manifests and registry publication remain separate release decisions. Existing 0.7 hosted artifacts remain a separate immutable release. Reconnect a host only when explicitly adopting the reviewed candidate.

For the staged customer workflow and verified private downloads, see [the Affine CLI guide](examples/affine-cli.md). Run `reliqua affine status --json` with your training key to inspect your actual qualified profiles before preparing a request.

## Connection and version boundaries

Customer fetch transports default to `https://api.reliqua.ai`. Pass an origin only, without `/api`, a path, query or fragment. `https://app.reliqua.ai` is the existing application proxy. Other reviewed HTTPS origins and HTTP loopback development origins are accepted. Browser clients inject their existing same-origin session transport instead of a workspace key.

| Audience / surface | Credential | Additional authority and availability |
| --- | --- | --- |
| Generation or evaluation catalogue | None | Discovery does not authorize ordering or establish qualified capacity. |
| Owned generation orders, quotes and files | Bearer workspace key with `orders:write` | Account approval, source/model support, credit and dispatch gates are checked by the service. |
| Owned CPU job, capability, event, artifact and worker reads | Bearer workspace key with `resources:read` | Active account and owner isolation. |
| CPU job/input/worker writes | Bearer workspace key with `resources:write` | Upload, create, resume and worker enrollment also require the dataset or training submission grant. |
| Owned evaluations, quotes and files | Bearer workspace key with `evaluations:write` | Evaluation approval, frozen-set/harness support, credit and execution gates remain server checks. |
| Browser generation and jobs | Existing session transport | It owns cookies, approved origins and XSRF; native projections additionally require fresh administrator verification. |
| Native subnet operator client | Existing administrator browser transport | Wallet verification and exact-action proofs; customer workspace keys do not authorize these operations. |

Keys stay in a server-side environment or secret store. The bundled key transports omit browser cookies, refuse redirects, restrict requests to their own route allowlists and never retry mutations automatically. `timeoutMs` defaults to 60,000 and accepts 1–120,000 milliseconds; `fetch` can be injected for a reviewed transport or local tests.

The package version, each wire protocol and the artifact installed by a consumer are independent:

| Package / consumer | Covered contract artifacts | Meaning |
| --- | --- | --- |
| This source package, `0.12.0` | Generation `0.3.0`, jobs `0.2.0`, evaluations `0.2.0`, OpenAI-compatible Batch `0.1.0` | Defines the exports and helpers described here; it is not evidence of a deployed service or consumer upgrade. |
| Older platform pin `vendor/api-client-0.2.2.tgz` | Generation and jobs exports | A consumer retaining this pin does not acquire the newer evaluation exports by reading this README. |
| A reviewed consumer artifact | Inspect its manifest, lockfile, version and integrity | Upgrade explicitly; never replace a tarball under an unchanged version or assume source `main` is installed. |

For SDK use, copy the reviewed `reliquary-api-0.12.0.tgz` into the consuming project as `vendor/api-client-0.12.0.tgz`, then run `npm install --save-exact ./vendor/api-client-0.12.0.tgz` there. Keep its manifest and lockfile together so the version and integrity pin agree. No public registry is required. The clients, CLI and examples require Node.js 22 or later. The checkpoint helper retains up to 24 fixed-set requests under one aggregate approval and polls pending orders every 30 seconds; verified reports use digest-pinned sidecars.

Generation contract 0.3.0 adds evaluations on a customer's file (the `grader` quote field, `purpose`/`grader` on the quote, `evaluation` and `purpose` on the order, `pricing.grading_fee_usd`), the file quote's `architecture`, `gpu_count`, `thinking`, `verification` and `seed`, the processed file's `sha256`, the file list's `object` and the catalogue's `architectures`. Evaluations contract 0.2.0 adds `verification` to forced-draw quotes and orders. The new OpenAI-compatible Batch contract 0.1.0 (`@reliquary/api/openai-batch/openapi`) describes `/api/openai/v1/files` and `/api/openai/v1/batches` for the official OpenAI SDKs; this package has no client for it. Jobs retains the wire version listed above. The bounded evaluation transport now rejects the HTTP-only webhook-secret rotation path. Direct generation/evaluation transport mutations classify HTTP 408 as `outcome_unknown`, preserving the original key and response diagnostics without retrying.

Public run monitoring is available through `createPublicClient().read("runs")` and `.run(publishedId?)`; results retain the upstream envelope, source clocks, unavailable states, nulls and metric meanings. The CLI supports the same stored telemetry reads without credentials. This is a bounded public-read helper, not a generated monitoring OpenAPI or typed training orchestration SDK. Account/key management, worker protocols and training orchestration keep their separately scoped HTTP contracts and native operator boundaries.

## Generation

Start with a public discovery request; it creates no order and needs no credential:

```sh
curl --fail-with-body --silent --show-error https://api.reliqua.ai/api/v1/generation/catalog
```

After installing the reviewed package, the equivalent client request is:

```ts
import { createGenerationClient, createGenerationTransport } from '@reliquary/api';

const transport = createGenerationTransport({
  origin: 'https://api.reliqua.ai',
  apiKey: process.env.GENERATION_API_KEY, // existing orders:write workspace key
});
const generation = createGenerationClient(transport.request);
const catalog = await generation.catalog();
// catalog.architectures: the config.json architectures[0] values pinned-model, Batch and evaluation
// quotes accept (null until the platform has read the list).
```

To inspect owned history without creating work, call `await generation.orders()` and then `await generation.detail(ownedOrderId)` with an ID from that response. To request a quote, select an exact model ID and one of that model's source IDs from the returned catalogue:

```ts
const quote = await generation.quote({
  model: 'MODEL_ID_FROM_CATALOG',
  source: 'SOURCE_ID_FROM_THAT_MODEL',
  prompt_count: 1,
  samples_per_prompt: 1,
  max_new_tokens: 128,
  thinking: false,
});
console.log({ quoteId: quote.quote_id, priceUsd: quote.price_usd, expiresAt: quote.expires_at });
```

Replace the two identifiers with reviewed catalogue values. A quote does not create an order or reserve credit. Pinned-model requests instead use an exact `model` repository, 40-character `revision` and `env`; see the [generation schema examples](contracts/generation.openapi.json).

The client provides `catalog`, `quote`, `create`, `orders`, `detail`, `cancel` and `downloadPath`. Public catalogue reads need no key. An approved account reviews the quote's configuration, price and expiry before explicitly calling `create(quoteId, originalRequestKey)`. Preserve that quote and its 16–80 character `Idempotency-Key` if the result is ambiguous. The transport never retries mutations automatically. Cancellation can remain asynchronous; read the resulting order state.

Browser callers reuse their existing same-origin session transport:

```ts
const generation = createGenerationClient(
  (path, init) => platformApi.request(path, init),
  { audience: 'browser' },
);
```

That transport owns session cookies, approved mutation origins, XSRF and session expiry. API-key routes use `/api/v1/dataset-orders`; browser routes use `/api/batch/orders`. Browser order responses include billing and browser delivery URLs; key responses omit that receipt. `catalog()` and `quote()` preserve the common response format. List responses contain the newest 100 owned orders and expose no cursor.

For key downloads, `transport.download(orderId, deliveryId, fileName, { offset, maxBytes })` returns bytes and content metadata. Each read is bounded to at most 256 KiB by the client, checks 200/206 and validates partial ranges. The server also permits full-file responses; the client bound is not a server range limit. Resolve identifiers from owned detail and verify file size/digest when assembling an artifact.

### Batch files

A batch file is an OpenAI Batch JSONL (`custom_id`, `method`, `url` `/v1/chat/completions` or `/v1/completions`, `body`) of at most 200 MB, uploaded in parts and then quoted on a pinned model. Its lines carry their own messages and sampling; the platform renders and checks them and reports refused lines in the quote's `line_errors` and the delivery's errors file. The Node entry point does the parts and the disk writes:

```ts
import { createGenerationClient, createGenerationTransport } from '@reliquary/api';
import { uploadFile, downloadDelivery } from '@reliquary/api/node';

const transport = createGenerationTransport({ apiKey: process.env.GENERATION_API_KEY });
const file = await uploadFile(transport, './requests.jsonl'); // resumable: pass { fileId } to finish an interrupted upload
const generation = createGenerationClient(transport.request);
const quote = await generation.quote({ model: 'org/name', revision: 'FULL_40_HEX_COMMIT', input_file_id: file.id, output_format: 'openai_jsonl' });
// Review price, line_errors, preview and expiry, then order with a stable key:
const order = await generation.create(quote.quote_id, 'stable-request-key-0001');
// Later, once delivered:
const files = await downloadDelivery(transport, await generation.detail(order.id), './results');
```

`downloadDelivery` writes `<directory>/<delivery id>/<file>`, resumes a partial file by `Range`, and checks each file's size and verifies its sha256 when supplied by the order. It preserves existing completed files, reuses matching files, and refuses links or special-file destinations. Downloaded bytes with a mismatching digest stay outside the final filename; `.rejected` is used when available without replacing an existing file. New directories and files have owner-only permissions. Use a directory you control and do not replace its entries concurrently; hostile shared destinations are unsupported. Resume uploads with the same unchanged source and file id.

Outputs are `output-*.jsonl` (OpenAI batch output lines) or `part-*.parquet`, `errors-*.jsonl` and `report.json` (verification and billing basis). `createBatchFileClient(transport)` exposes the file routes directly (`create`, `putPart`, `complete`, `get`, `list`); a processed file carries its `sha256` (null until the platform has read a file uploaded in parts). The quote names the model's `architecture`, the `gpu_count` of the node that verifies it, `verification: 'draw'` and the lines' `seed`.

To evaluate a model on your own questions, give every line a top-level `reference` (the expected answer, at most 4,096 characters) and quote with a `grader`, `boxed_math_v1` or `exact_match_v1` (`FILE_GRADERS`):

```ts
const quote = await generation.quote({ model: 'org/name', revision: 'FULL_40_HEX_COMMIT', input_file_id: file.id, grader: 'boxed_math_v1' });
// quote.purpose === 'eval', quote.grader, quote.pricing.grading_fee_usd (before the margin; included in price_usd)
const order = await generation.create(quote.quote_id, 'stable-request-key-0002');
// Later: (await generation.detail(order.id)).evaluation -> { grader, status: 'pending' | 'graded' | 'ungraded', complete, summary }
```

`summary.envs` holds one entry named after the grader (pass@1 with its 95 % interval, pass@k, mean_score and row counts) and `summary.macro` the macro scores. The graded files are delivered under delivery `evaluation` (`graded.parquet`, `report.json`, `manifest.json`) beside the completions; `downloadDelivery` saves both. Without a grader, lines that carry a `reference` are refused. See the [file evaluation reference](https://app.reliqua.ai/docs/api-reference/file-evaluations).

Customers that prefer the official OpenAI SDK send the same file to the platform's OpenAI-compatible routes (`base_url` `https://app.reliqua.ai/api/openai/v1`, same `orders:write` key); `metadata.reliquary_grader` makes such a batch an evaluation. [openai-batch.openapi.json](contracts/openai-batch.openapi.json) describes those routes; they quote and order in one call. Review a native quote first, set `metadata.max_price_usd` to the approved ceiling, and send a stable `Idempotency-Key` with the OpenAI SDK request and any retry.

Catalogue visibility, account permission, ordering gates, execution capacity, delivery, verification and financial settlement are separate facts. This package documents the existing workflow and does not enable services or guarantee live ordering. Structural schemas complement runtime checks for configuration identity, resolved delivery links, unique identifiers, monetary precision and receipt sums. Existing runtime contracts and workload qualification remain authoritative.

## Jobs

```ts
import { createJobsClient, createJobsTransport } from '@reliquary/api/jobs';

const jobs = createJobsClient(createJobsTransport({
  apiKey: process.env.JOBS_API_KEY,
}).request);
const page = await jobs.list({ limit: 25 });
const capabilities = await jobs.capabilities();
```

Customer routes support owned CPU `dataset_validation` jobs. Reads require `resources:read`; writes require `resources:write`. Input uploads, job creation, resume and worker enrollment also require the account's dataset or training submission grant. Owned history and cancellation remain accessible after that grant is withdrawn, subject to an active account. Server permission checks remain authoritative.

`uploadInput({schema_version:1, format, content}, originalRequestKey)` accepts up to 32 KiB of UTF-8 JSONL, using `instruction`, `preference` or `corpus`. The bounded JSON envelope permits escaped content. Its receipt pins owner-scoped dataset identity, SHA-256, format and byte size. Malformed rows may be submitted for validation; the report contains counts and safe error codes without row contents. Each selected format retains the existing dataset field rules. The client verifies the upload receipt against the actual bytes.

`create({schema_version:1, spec}, originalRequestKey)` requires the pinned input receipt and explicit deadline (60–3600 seconds) and attempt limit (1–3). A job contains a real work unit and its execution attempts. Worker claims, expiry and fencing belong to the service's durable scheduler; an API client never invents attempts. Report artifacts include their frozen size and digest, which the client checks before returning the report. Job timestamps use Unix epoch milliseconds.

`WORKLOAD_DEFINITIONS` identifies exactly these two implemented version 1 adapters and their schema references. CPU validation is safe to restart within its bounded attempt policy; native corpus recovery remains managed by its existing controller. Definitions describe the contract, while capability observations describe current owner-scoped authority and capacity. Adding an adapter requires an implemented, tested input/result mapping and its recovery policy.

`control(id, action, {schema_version:1, revision, reason}, originalRequestKey)` supports CPU pause, resume and cancel. It sends both the original UUID idempotency key and `X-Resource-Revision`. On `JobApiError('outcome_unknown')`, preserve `requestKey`, `revision` and the original input, then reconcile owned history and current state. Transport or response-validation failures never trigger an automatic mutation retry. List and event pages use bounded opaque cursors and a maximum limit of 100.

`JobApiError` and `GenerationApiError` can include `requestId` from `X-Request-ID` and `retryAfterSeconds` from `Retry-After`. Invalid hints are omitted; request IDs are limited to 128 safe characters and retry delays to 0–86400 seconds. Integer delays and standard GMT HTTP dates are supported. These optional diagnostics help identify a request and choose when to reconcile; they never enable automatic retries. Generation errors retain their original `retryKey`; job errors retain `requestKey` and `revision`.

Job routes share an owner limit across browser sessions and workspace keys: 240 GET requests and 120 writes per minute. HTTP 429 uses the existing `rate_limited` error envelope and supplies `Retry-After` and `X-Request-ID`. The CLI keeps its refusal message and prints a second JSON diagnostic line when these optional hints are available. Wait as directed before another explicit request; a response hint does not authorize replaying a mutation with a new key.

Capability reads distinguish submission permission, enrolled workers, recently seen workers, verified CPU workers and queued/running demand. Permission can allow a bounded job to queue while worker capacity is zero. CPU qualification does not establish GPU execution, subnet proof, incentives or settlement. Worker enrollment returns its scoped token once; a replay returns `token:null`, and token values never appear in worker list or job views.

Browser consumers inject their existing session transport using `{audience:'browser'}`. Fresh administrator verification additionally permits an owned `corpus_generation` projection. The projection preserves its native manifest, hash, source reference and phase, and exposes no synthetic work units or attempts. Native pause, resume and cancel additionally require the existing administrator browser transport and a wallet action proof for the exact reviewed body and route; its revision remains the native 64-character digest. Customer key clients reject these native controls. The economic task registry remains distinct from a workload definition, customer job or execution attempt. The customer OpenAPI documents CPU control contracts; native controls retain this separate operator security requirement.

`createSubnetTaskClient` delegates native catalog/read/launch/cancel to an injected administrator browser transport `(path, init, confirmation)`. Reuse the existing wallet verification and action-proof flow; customer API keys cannot replace it. Native mutation bodies, canonical manifest field order, hashes, original request UUID and revision conventions are preserved. These operator actions and worker lease protocols are excluded from the customer OpenAPI document.

## CLI

`jobctl` uses the same scoped client and validated contracts. `definitions` prints the shipped adapter metadata locally. `capabilities`, `list`, `status`, `events` and `report` read owned resources. `upload`, `submit`, `pause`, `resume` and `cancel` require explicit `--confirm` and the caller's original UUID `--request-key`. Submit reads a bounded JSON request file; upload reads a bounded UTF-8 JSONL file. The CLI does not provision capacity or enroll workers implicitly.

```sh
export JOBS_API_KEY=... # supply through your normal secret mechanism
jobctl list --limit 25
jobctl submit --file request.json --request-key ORIGINAL_UUID --confirm
jobctl --help
```

## CPU quickstart

With an existing `resources:write` key, dataset or training approval, and an available owned CPU worker, run the shipped [validation example](examples/validate-dataset.mjs). This example submits a real bounded validation job; it creates no worker credentials and provisions no capacity. `can_submit` permits queueing and does not guarantee a qualified worker is currently available.

Prepare an `instruction` JSONL file, for example `{"prompt":"Example question","response":"Example answer"}`. Generate and retain two distinct UUIDv4 values once through your normal request journal. Supply those same values and the unchanged file for any explicit reconciliation retry; do not generate fresh keys after an ambiguous result.

```sh
export JOBS_API_ORIGIN=https://api.reliqua.ai
export INPUT_REQUEST_KEY=RETAINED_UPLOAD_UUID
export JOB_REQUEST_KEY=RETAINED_SUBMISSION_UUID
# JOBS_API_KEY comes from your normal secret mechanism.
node node_modules/@reliquary/api/examples/validate-dataset.mjs input.jsonl
```

The example checks capabilities, uploads at most 32 KiB of UTF-8 JSONL, submits the immutable input reference with a 300-second deadline and at most two attempts, and polls for up to 90 seconds. It prints the job and original keys before polling. The client verifies the report's artifact digest, and the example also checks its input digest and format. An invalid dataset still has a verified report and exits with status 1. Set `JOBS_DATASET_FORMAT=preference` or `corpus` for the other supported formats.

If polling times out or the job pauses or needs attention, read its state with `jobctl status --id JOB_ID`; the job remains available within its original lifecycle. Use `jobctl events` for history and `jobctl report --id JOB_ID --artifact ARTIFACT_ID` to fetch the digest-verified report. To pause, resume or cancel, inspect the current revision and explicitly use the existing control command with the original control UUID, revision, reason and `--confirm`. The CLI's unknown-outcome JSON retains the original key, revision and optional response diagnostics. No mutation is retried automatically.

```sh
npm ci
npm test
npm pack
```

Checks use Node's test runner, OpenAPI reference/operation assertions and synthetic examples through the shipped validators. A clean packed installation and CLI are exercised against a local HTTP server. Tests make no production requests, orders or provisioned rentals.

### Test reports

CI keeps a unit-test count summary for seven days, including failed runs.
Generated reports stay in ignored `test-results/`; logs, credentials and raw
response bodies are not uploaded. Maintained tests and fixtures remain versioned.

## Pinned checkpoint evaluations

**Service compatibility:** these helpers require deployed evaluation support for `client_ref`, exact reconciliation filters and the documented quote fields. Read current catalog `qualified_support` and protocol pins before selecting frozen sets; older services or retained consumer packages may not support them. Installing this client does not upgrade the service or qualify execution.

The evaluation client uses the existing `/api/v1/evaluations` order API and an
`evaluations:write` workspace key. Evaluation approval, current qualified sets,
pricing and execution availability remain server gates. These examples do not
provision capacity or make a source support an unqualified harness.

```js
import { createEvaluationClient, createEvaluationTransport } from '@reliquary/api/evaluations';
const transport = createEvaluationTransport({ apiKey: process.env.EVALUATIONS_API_KEY });
const evaluations = createEvaluationClient(transport.request);
const catalog = await evaluations.catalog();
```

The client provides `quote`, `create`, `orders`, `detail`, `cancel` and
`downloadPath`, plus bounded file downloads through `transport.download(id,
name, range)`. It shares the existing safe exchange without allowing generation
or administrator routes. `orders({quote_id, client_ref})` reconciles exact owned
receipts before an explicit retry. Mutations are sent once; an ambiguous result
retains the original quote, key and request. Cancellation is a separate explicit
action. The [evaluation OpenAPI](contracts/evaluations.openapi.json) describes
the wire contract and synthetic examples.
The contract also describes webhook-secret creation/rotation as an HTTP-only operation; the evaluation client and bounded transport do not expose it.

Qualified set cards retain `protocol`, exact `protocol_json`, its SHA-256 and
`qualified_support`. Producer JSON bytes are the digest authority; duplicate
decoded keys are rejected. The global request protocol is model independent,
so unchanged sets, graders, harness, sampling and budgets keep one comparison
identity across checkpoints. Model repository, revision and access intent are
separate immutable pins. Older unpinned reports remain readable; they cannot
qualify a pinned checkpoint comparison.

`examples/evaluate-checkpoint.mjs` accepts 1–24 distinct fixed-set requests and
one model checkpoint per owner-only journal, with one fixed set per request.
It requires explicit set IDs, 40-character model revisions, sampling seeds,
source-qualified harness/turn bounds and transcript/time budgets. Current frozen
comparisons require qualified direct mode. Unsupported multi-turn sources fail closed.
`telecom-episode-v1` requires explicit `thinking: true` because its pinned
renderer and response parser use the reasoning format.
`max_new_tokens` limits each model turn; `max_episode_tokens` includes the full
prompt, history and tool transcript. A small model context can require a lower
episode budget than the default offered by the server.

Prepare a configuration such as this synthetic example, replacing the model,
revision and set with reviewed current catalog values:

```json
{
  "schema_version": 1,
  "trainer_run_id": "actual-trainer-source-id",
  "checkpoint_step": 100,
  "client_ref": "checkpoint-100",
  "max_total_usd": 0,
  "requests": [{
    "model": "example/model",
    "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "mode": "direct",
    "model_access": "public",
    "envs": [{"env": "example", "set_id": "fixed-heldout-set", "problems": 2, "samples": 1}],
    "sampling": {"temperature": 0.6, "top_p": 0.95, "top_k": 20, "seed": 0},
    "thinking": false,
    "max_new_tokens": 128,
    "harness": "single-turn",
    "max_turns": 1,
    "max_episode_tokens": 4096,
    "episode_timeout_seconds": 300
  }]
}
```

Use the optimizer step from the actual checkpoint or trainer manifest.
Neither a W&B history step nor a checkpoint filename establishes that value.
Keep the state in a directory with mode0700 outside repositories:

```sh
node examples/evaluate-checkpoint.mjs checkpoint.json /private/state/checkpoint.private.json
```

Preparation retains the exact quote IDs, prices, expiry and protocol, without
placing an order. After reviewing those quotes, set the approved numeric
`max_total_usd` ceiling and explicitly add `--confirm`. The ceiling covers the
sum of all selected requests in that journal, checked before any order POST;
separate journals have separate ceilings. The journal records that exact
approval before any order POST. Once confirmation was attempted, changing the ceiling,
quote, checkpoint, set, seed or other input is refused. No key or quote is
replaced after an unknown outcome. An expired quote requires reconciliation
and a new reviewed intent; this journal does not silently refresh it.

For a matched baseline/candidate run, first prepare the baseline journal and
retain each quote's model-independent `protocol_sha256`. Copy its requests into
a separate candidate configuration, changing only the model revision and actual
checkpoint metadata, and add `comparison_protocols`, keyed by every selected
`set_id`, with those reviewed quote digests. For example:

```json
"comparison_protocols": {
  "fixed-heldout-set": "<64-character baseline quote protocol_sha256>"
}
```

Every selected set must have exactly one pin. The candidate refuses a changed
set, grader, sampler/seed, thinking mode, harness or budget before any order
confirmation. Retained quotes are checked again on resume and export. Keep the
baseline's original journal intact; pins are part of the candidate's new intent.
Without this optional field, standalone evaluations retain their existing flow.

A rerun without `--confirm` reconciles and reads only. After a lost
acknowledgement it queries the original quote and client reference; explicit
`--confirm` may replay the unchanged original confirmation when no receipt was
found. A401/403 does not establish that the earlier order was absent. Read
retries honor bounded `Retry-After` hints, with at most five attempts; ordinary
polling reads pending orders immediately, then every 30 seconds, and stops
after 30 rounds or 90 seconds. Timeout never cancels or submits
another order. Exit2 means results remain pending or were not delivered.

The journal uses atomic replacement, mode0600 and a local exclusive lock. It
binds the normalized API origin and a local credential fingerprint without
storing the key. A rotated key requires operator reconciliation; there is no
credential bypass. Following a process crash, verify that process stopped
before removing its stale `.lock` file. This is a local single-writer journal.

Verified reports retain their exact UTF-8 bytes in digest-named mode0600 files
inside the owner-only mode0700 `<journal>.reports` directory. Each report is
bounded to 8 MiB and durably published before its journal reference; parsed
reports are hydrated in memory rather than duplicated in the journal. Keep the
journal and its report directory together outside source repositories. Resume
and export verify the filename, size, SHA-256 and report schema; missing,
modified or symbolic-link reports stop without automatic downloads or order
retries. Existing bounded journals with inline reports remain readable.

The script verifies the report's bytes, size, digest, evaluation ID, checkpoint,
set provenance and frozen protocol. Machine output retains unique graded
problem counts separately from requested/completed/graded sample rows.
`mean_score` is the native per-problem mean, with `n_problems_graded` as its
denominator. `pass@1`, `pass@k`, truncation and format metrics retain their
native names; absent observed turns, tool calls or attempts remain null.
Correct/wrong sample grades remain in `graded.parquet`; capped outputs retain
termination/truncation diagnostics. Missing or ungraded rows are execution or
grading gaps, and must not be described as measured wrong answers. The
conservative headline `pass@1` includes those gaps in its denominator; benchmark
export requires complete graded coverage.
`graded.parquet` is the existing actual per-problem sample artifact. Its owned
file descriptor is returned alongside the report; download it through the same
authenticated, range-bounded API and verify the complete file digest. No R2
credentials or manual storage work are required.

## Approved benchmark publication

`examples/export-checkpoint-benchmarks.mjs` publishes only complete verified
reports whose frozen set has reviewed `disjointness.disjoint: true` and an
`evidence_sha256`. Unknown overlap or training data cannot become `held_out`
through a CLI flag. Results must retain actual native producer `created_at`
clocks, converted from seconds to milliseconds; fetch and order timestamps are
never substitutes. Export revalidates each original request against its retained
quote, then the order against that quote, before accepting the verified report.

Export additionally requires an owner-only reviewed publication evidence file.
It retains `approved: true`, the actual W&B `trainer_run_id`, `repo_id` and exact
40-character `revision`; `publication_source` and `profile_source` must name
`https://huggingface.co/<repo>/resolve/<revision>/reliquary_publication.json`
and `reliquary_protocol_profile.json` respectively. Preserve each file's exact
UTF-8 bytes in `publication_json`/`profile_json` with its SHA-256 in
`publication_sha256`/`profile_sha256`. Review those immutable sources and the
native `training_run_id` to W&B trainer mapping before approving the file.
The exporter verifies the native receipt pins the profile, both native run IDs
agree, and `lr_schedule_step` equals the configured optimizer step. It never
uses `checkpoint_n`, a filename or W&B history step as an optimizer step.
An `async_hf_backup` publication also binds the same `async_checkpoint_run`
and `async_task_id` in its manifest and profile. Its first commit may retain
`parent_revision: null`; other publication kinds still require an immutable
parent revision. The uploaded checkpoint revision remains mandatory in every case.
These reviewed source copies are evidence inputs, not an online authenticity
check; no HF or object-storage credentials are requested. Missing publication
metadata prevents benchmark export while evaluation remains usable.

Standalone evaluations may set `checkpoint_step: null` when the optimizer step
is unknown. A null step can be exported only when `baseline_checkpoint` exactly
matches that model and revision. For that baseline, the reviewed evidence file
retains `approved`, `trainer_run_id`, `repo_id`, `revision`, `checkpoint_source`
(`https://huggingface.co/api/models/<repo>/revision/<revision>?blobs=true`),
the exact metadata bytes as `checkpoint_json` and their `checkpoint_sha256`.
The metadata must bind the snapshot and a weight artifact. The baseline keeps
`step: null`; it does not acquire an invented training counter or trainer lineage.
Trajectory checkpoints still require the native publication and optimizer step
described above.

Use one export journal and one exporter for an already-created dedicated W&B
run in the trainer's entity/project. That run must have `job_type="evaluation"`
and a different ID from the actual trainer. The optional Python bridge uses the
[official W&B Public API](https://github.com/wandb/wandb/blob/main/wandb/apis/public/runs.py)
from an environment where `wandb` is installed. It does not call `wandb.init`,
write trainer summaries, log training history or fall back to another run.

```json
{
  "schema_version": 1,
  "entity": "approved-entity",
  "project": "approved-project",
  "evaluation_run_id": "dedicated-evaluation-id",
  "trainer_run_id": "actual-trainer-source-id",
  "approved": true
}
```

```sh
node examples/export-checkpoint-benchmarks.mjs target.json /private/state/export.private.json /private/state/checkpoint.private.json /private/state/publication.private.json
```

`WANDB_API_KEY` remains in the environment; optional
`EVALUATIONS_WANDB_PYTHON` selects the existing interpreter. The exporter reads
the exact trainer identity and writes only the dedicated run's
`reliquary_run_benchmarks` summary object. Its envelope uses
`reliquary.run-benchmarks.v1`, the actual trainer `run_id`, fractional native
mean scores and unique graded-problem denominators. Evaluation charges never
populate training `cost_usd` or `gpu_hours`; both remain null.

A changed protocol gets a new series ID. Checkpoints and optimizer steps are
unique and strictly increasing; retries of an identical result are no-ops.
An optional `baseline_checkpoint` in the target must explicitly name the
`model@revision`; the first checkpoint is never assumed to be a baseline.
The envelope is bounded to 24 protocols, 120 checkpoints each and 512 KiB UTF-8.
Private samples, credentials and infrastructure metadata are excluded. Unknown
publication acknowledgements retain the exact pending object; the bridge
compares the previous object and rereads the dedicated summary before marking
publication verified. One journal per dedicated run is required; this does not
provide a distributed compare-and-swap service.

## Assisted Affine pilot

Import `createAffinePilotClient`, `createAffinePilotTransport` and `affinePilotRequests` from `@reliquary/api/affine-pilot` (also root exports). The injected client uses the same fixed routes as the narrow bearer transport. Preparation status is availability plus owned history; no API claims a wallet invitation or opens a window. Those remain human browser actions. The default has no live GPU.

The supported checkpoint is a public full MiMo-compatible 9B safetensors model, at most 20 GiB. Review resolves its immutable revision and `mimo-diagnostic4-v1` four-case policy. Preparation needs an open window with at least 70 minutes remaining, an explicit approval and a ceiling no higher than $5.10. Final execution requires a separate exact approval. This same-host diagnostic is source-pinned; it does not establish current official Affine parity, operator acceptance, reward verification or a promotion gate.

Use [the staged fetch example](examples/affine-pilot.mjs) and [OpenAPI contract](contracts/affine-pilot.openapi.json) for review → preparation → status → evaluation request → authorized JSONL upload → saved configuration → optional service-credit quote → separately approved task → bounded artifact retrieval and receipt verification. The transport requires a `training:write` key and a distinct `resources:write` key for saving the draft. It refuses redirects, cookies, unrelated routes and automatic retries. Preserve each exact request and its stable key before a write; `outcome_unknown` requires reconciliation, never a replacement key. The checkpoint diagnostic uses the SDK or MCP. The batch CLI below has separate staged execution approvals.

## Affine batch SDK and CLI

`@reliquary/api/affine-batches` exports `reviewAffineBatch(bytes, hotkey, miningBytes)`, `exportAffineBatch(wireObject, hotkey, miningBytes)` and `planAffineBatch(bytes, miningBytes, options)`. These pure functions use complete UTF-8 JSON (at most 64 MiB), preserve the original byte digest and consume a raw supplied mining.json snapshot (at most 1 MiB). Export serializes an explicit v1/v2 wire object without changing it. Whole groups are dropped in file order at the supplied prompt/rollout caps; structural checks cover all groups first. One rollout is sufficient. v2 learning rate/KL bounds are inclusive and never clamped; bounds and defaults unsupported by the fixed kit revision are refused.

Reports are structural-only: full output/context token validation requires the official head tokenizer. The pinned plan describes batch export/validation, one GRPO step and parent/candidate comparison through the external official-kit wrapper. It contains placeholders, independent descriptor digests, explicit seed, raw mining snapshot digest, prior availability and a frozen clock; it executes nothing. CPU tiny commands prove plumbing only. Missing fp32 master, private prior/selection and production kernels prevent official parity. Qualification remains not_run and acceptance/submission/parity flags remain false. No credentials, chain registration, remote upload or paid endpoint is added.

This source candidate is separate from the 0.7 checkpoint diagnostic. The [pinned official miner guide](https://github.com/AffineFoundation/affine/blob/eaf1ad20e4d018c85b30f53e9807b2b9a6a75e25/miner/README.md) and bundled `reliquary-affine-batches` skill describe the workflow; install this candidate from its reviewed source tarball. Hosted artifacts require their own matching verified release manifest. Keep batches, generated plans and execution evidence private outside repositories.

The hosted batch workflow additionally exports `createAffineBatchClient`, `affineBatchRequests`, and strict `parseAffineBatch{Profile,Request,Prepared,Receipt,Result}` functions from `@reliquary/api/affine-batches` and the package root. Pass the existing `createAffinePilotTransport({ apiKey, resourcesApiKey, origin }).request` to the client. `prepare({ profileDigest, maxHours, maxCostMicroUsd })` selects an already approved owner profile; it does not start compute. Upload only the returned small metadata request with `uploadRequest(request, 'batch.jsonl', true)`, then `saveDraft(prepared, name, stableDraftKey)`. The saved configuration fixes `affine_batch`, one optimizer step, private compute and the same request. Actual batch/model bytes belong to the approved frozen job, rather than this metadata upload.

Use [the staged hosted example](examples/affine-batch-pilot.mjs): `node examples/affine-batch-pilot.mjs STAGE INPUT.private.json`. Stages are `prepare`, `upload`, `save-draft`, `quote`, `start`, `task`, and `verify-delivery`. Credentials use `TRAINING_API_KEY` (`training:write`), `RESOURCES_API_KEY` (`resources:write`) and optional `RELIQUARY_API_URL`. Save each returned response privately before proceeding. Draft input is `{ prepared, name, requestKey }`; start input is `{ submission: { draftId, revision, datasetId, approveExecution: true }, requestKey }`. Execution requires this separate approval and a stable key. Preserve original keys on ambiguous outcomes; no stage retries automatically. A quote is optional for this operator-funded profile. No stage rents hardware or claims a wallet invitation.

For `verify-delivery`, supply `{ taskId, request, pins }`, where `pins` contains the independently retained `profileDigest`, `environmentDigest`, uploaded request byte hash `requestSha256`, and approved `affineBatch` profile. The example checks the task/result, exact source/model/job/context bindings, fractional training clock, bounded streamed archive hash and Ed25519 receipt signature. It accepts finite negative gains and nullable estimator metrics. This establishes delivered integrity against the retained signer/profile; it does not independently rerun the estimator, attest inference identity, establish improvement, or establish live parity, official acceptance, reward verification or chain submission. Those assurance flags remain false. A scientific RED decision remains a valid delivered result.

Current Affine batch preparation supports all 16 typed train fields at source revision `eaf1ad20e4d018c85b30f53e9807b2b9a6a75e25`. Fixed-z plans use current-round 12,288 output / 16,384 context and explicitly report PUBLIC PRIOR APPROXIMATION, without private IRT parity. JSON integer validation requires the standard reviver source context (supported on the Node.js 22 minimum); runtimes without it fail closed for explicit step_mult. Local checks used Node.js 24.21.0. Historical receipt formulas remain valid. Current plans pin the zero run-noise floor; older gate snapshots require their matching reviewed release. For Arbos setup and an operator-assisted pilot, see [the Arbos guide](examples/arbos-affine.md).
