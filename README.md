# Generation and job contracts and clients

Private `@reliquary/api` 0.2.2 contains generation and job contracts, runtime validators, request-injected TypeScript clients and bounded fetch transports. The [generation contract](contracts/generation.openapi.json) retains its 0.1.0 protocol and the [job contract](contracts/jobs.openapi.json) its 0.2.0 protocol. Both use OpenAPI 3.1.1 / JSON Schema 2020-12; job payloads use schema version 1.

Pin the reviewed `vendor/api-client-0.2.2.tgz` artifact in the consumer's package manifest and lockfile. Updating the package requires an explicit version and integrity update; this release does not depend on a public registry. The CLI and quickstart require Node.js 22 or later.

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
