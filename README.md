# API contracts and clients

Private `@reliquary/api` 0.3.0 contains generation, job and evaluation contracts, runtime validators, request-injected TypeScript clients and bounded fetch transports. The [generation contract](contracts/generation.openapi.json) retains its 0.1.0 protocol and the [job contract](contracts/jobs.openapi.json) its 0.2.0 protocol. The [evaluation contract](contracts/evaluations.openapi.json) adds pinned checkpoint workflows. All use OpenAPI 3.1.1 / JSON Schema 2020-12; job payloads use schema version 1.

Pin the reviewed `vendor/api-client-0.3.0.tgz` artifact in the consumer's package manifest and lockfile. Updating the package requires an explicit version and integrity update; this release does not depend on a public registry. The CLI and quickstart require Node.js 22 or later.

Customer transports default to `https://api.reliqua.ai`. Set `origin: 'https://app.reliqua.ai'` to use the existing application proxy, or supply another reviewed HTTPS origin. Browser clients retain their injected same-origin session transport.

```ts
import { createGenerationClient, createGenerationTransport } from '@reliquary/api';

const transport = createGenerationTransport({
  origin: 'https://api.reliqua.ai',
  apiKey: process.env.GENERATION_API_KEY, // existing orders:write workspace key
});
const generation = createGenerationClient(transport.request);
const catalog = await generation.catalog();
```

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

Qualified set cards retain `protocol`, exact `protocol_json`, its SHA-256 and
`qualified_support`. Producer JSON bytes are the digest authority; duplicate
decoded keys are rejected. The global request protocol is model independent,
so unchanged sets, graders, harness, sampling and budgets keep one comparison
identity across checkpoints. Model repository, revision and access intent are
separate immutable pins. Older unpinned reports remain readable; they cannot
qualify a pinned checkpoint comparison.

`examples/evaluate-checkpoint.mjs` accepts one fixed set per request and one
model checkpoint per owner-only journal. It requires explicit set IDs,
40-character model revisions, sampling seeds, source-qualified harness/turn
bounds and transcript/time budgets. Current frozen comparisons require
qualified direct mode. Unsupported multi-turn sources fail closed.
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
`max_total_usd` ceiling and explicitly add `--confirm`. The ceiling covers this
checkpoint's selected requests only. The journal records that exact approval
before any order POST. Once confirmation was attempted, changing the ceiling,
quote, checkpoint, set, seed or other input is refused. No key or quote is
replaced after an unknown outcome. An expired quote requires reconciliation
and a new reviewed intent; this journal does not silently refresh it.

A rerun without `--confirm` reconciles and reads only. After a lost
acknowledgement it queries the original quote and client reference; explicit
`--confirm` may replay the unchanged original confirmation when no receipt was
found. A401/403 does not establish that the earlier order was absent. Read
retries honor bounded `Retry-After` hints, with at most five attempts; ordinary
polling stops after30 rounds or90 seconds. Timeout never cancels or submits
another order. Exit2 means results remain pending or were not delivered.

The journal uses atomic replacement, mode0600 and a local exclusive lock. It
binds the normalized API origin and a local credential fingerprint without
storing the key. A rotated key requires operator reconciliation; there is no
credential bypass. Following a process crash, verify that process stopped
before removing its stale `.lock` file. This is a local single-writer journal.

The script verifies the report's bytes, size, digest, evaluation ID, checkpoint,
set provenance and frozen protocol. Machine output retains unique graded
problem counts separately from requested/completed/graded sample rows.
`mean_score` is the native per-problem mean, with `n_problems_graded` as its
denominator. `pass@1`, `pass@k`, truncation and format metrics retain their
native names; absent observed turns, tool calls or attempts remain null.
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
never substitutes.

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
