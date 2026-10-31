# Contract reference

This index describes the private `@reliquary/api` 0.6.0 package. A contract file defines a wire format; it does not establish deployment, account approval, funded capacity or successful execution. See the [connection, scope and version guide](../README.md#connection-and-version-boundaries) before calling a service.

All three documents use OpenAPI 3.1.1 and the JSON Schema 2020-12 dialect. `info.version` is the individual wire protocol version, not the npm package version. Examples are synthetic and validate against the shipped runtime parsers.

| Surface | OpenAPI / package export | Protocol | Client import |
| --- | --- | --- | --- |
| Generation | [generation.openapi.json](generation.openapi.json), `@reliquary/api/openapi` | `0.1.0` | `createGenerationClient`, `createGenerationTransport` from `@reliquary/api` |
| Jobs | [jobs.openapi.json](jobs.openapi.json), `@reliquary/api/jobs/openapi` | `0.2.0` | `createJobsClient`, `createJobsTransport` from `@reliquary/api/jobs` |
| Evaluations | [evaluations.openapi.json](evaluations.openapi.json), `@reliquary/api/evaluations/openapi` | `0.1.0` | `createEvaluationClient`, `createEvaluationTransport` from `@reliquary/api/evaluations` |

Load a contract from the installed artifact, so reference and client version agree:

```js
import generationContract from '@reliquary/api/openapi' with { type: 'json' };
import jobsContract from '@reliquary/api/jobs/openapi' with { type: 'json' };
import evaluationContract from '@reliquary/api/evaluations/openapi' with { type: 'json' };

console.log(generationContract.info.version, jobsContract.info.version, evaluationContract.info.version);
```

The older platform artifact `vendor/api-client-0.2.2.tgz` exposes generation and jobs, not the newer evaluation exports. Its job schema has an older browser-cookie label; the actual HTTPS session cookie is `__Host-reliquary_session` (`reliquary_session` on local HTTP). Reuse the platform session transport instead of constructing cookie authentication from that older schema. Updating this repository does not replace an installed artifact or change its integrity pin.

## Route and client coverage

**Evaluation compatibility:** the helpers require deployed support for exact `client_ref` / `quote_id` reconciliation and the documented extended quote fields. Inspect current catalog `qualified_support` and protocol pins; a client version does not upgrade an older service or qualify a fixed-set evaluation.

| Surface / audience | Routes | Access | Client coverage |
| --- | --- | --- | --- |
| Public generation discovery | `GET /api/v1/generation/catalog`, `GET /api/batch/catalog` | No key | `generation.catalog()`; key audience is the default. |
| Customer generation | `/api/v1/dataset-orders` and its quote, detail, cancel and delivery-file routes | `orders:write`, account/source/dispatch gates | `quote`, `create`, `orders`, `detail`, `cancel`, `downloadPath`; file bytes through `transport.download`. |
| Browser generation | `/api/batch/quotes`, `/api/batch/orders` and order subroutes | Existing session; mutations retain approved Origin and XSRF | Same client with `{ audience: 'browser' }` and injected session transport. |
| Customer CPU validation | `/api/v1/jobs`, `/api/v1/job-inputs`, `/api/v1/job-workers` and their subroutes | `resources:read` / `resources:write`, owner isolation and submission gates | `capabilities`, `list`, `detail`, `events`, `create`, `control`, `uploadInput`, `artifact`, `workers`, `enrollWorker`, `revokeWorker`. |
| Browser jobs | `/api/jobs`, `/api/job-inputs`, `/api/job-workers` and their subroutes | Existing session; native projections require fresh administrator verification | Same jobs client with `{ audience: 'browser' }`; customer CPU controls are described by this OpenAPI. Native controls require the separate operator action-proof flow. |
| Public evaluation discovery | `GET /api/v1/evaluations/catalog` | No key | `evaluations.catalog()`. |
| Customer evaluations | `/api/v1/evaluations` and its quote, detail, cancel and file routes | `evaluations:write`, evaluation approval and qualified source/harness gates | `quote`, `create`, `orders`, `detail`, `cancel`, `downloadPath`; file bytes through `transport.download`. |
| Evaluation webhook secret | `POST /api/v1/evaluations/webhook-secret` | `evaluations:write`, owner isolation | HTTP contract only. No client method or bundled-transport route for secret rotation. |

The generation and jobs documents include both customer-key and browser audiences. The evaluation document describes only the customer-key API. OpenAPI bearer security uses the `workspaceKey` scheme; the operation's `x-required-api-key-scope` states the required scope. Browser mutations retain their Origin/XSRF requirements and cannot be converted into key-authorized operator actions.

JSON Schema handles structural limits. Runtime validators additionally enforce identity, quote/request equality, exact protocol digests, ownership-linked identifiers, monetary sums and artifact digests. Do not treat schema validation alone as execution or result verification.

## Lifecycle and limits

| Concern | Generation | Jobs | Evaluations |
| --- | --- | --- | --- |
| List | Newest 100 owned orders; no cursor | Opaque cursor and `limit` 1–100 for jobs/events | Newest 100 matching owned orders; exact `quote_id` and `client_ref` filters, no cursor |
| Mutation identity | Order create retains the reviewed quote and a 16–80 character `Idempotency-Key` | UUIDv4 request key; controls also send the reviewed `X-Resource-Revision` | Create retains the reviewed quote, 16–80 character key and optional `client_ref` |
| Unknown result | Preserve original request/key and inspect owned state | Preserve original input/key/revision and reconcile events/state | Preserve original quote/key/client reference and reconcile filtered history |
| Cancellation | May acknowledge before work drains | Revision-controlled CPU pause/resume/cancel | Cooperative, state-specific cancellation; inspect returned state |
| Files / reports | Client download chunks at most 256 KiB; validate 200/206 and final digest | Client verifies validation report against frozen size/SHA-256 | Client chunks at most 256 KiB; verify file size/SHA-256 against the owned receipt |

Fetch transports do not retry mutations automatically. `GenerationApiError` exposes `code`, optional `status`, `retryKey`, `requestId` and `retryAfterSeconds`; `JobApiError` uses `requestKey` and `revision`. A diagnostic hint does not authorize a new mutation or a new key. Job routes currently share an owner limit of 240 GET requests and 120 writes per minute; 429 responses carry `Retry-After` and `X-Request-ID`.

## Other exports and surfaces

`@reliquary/api/batch-orders` and `@reliquary/api/product-inventory` expose generation payload types and parsers. `@reliquary/api/subnet-tasks` exposes native manifest/run types and validators; `@reliquary/api/subnet-client` exposes `createSubnetTaskClient` for an injected administrator browser transport. The operator client has `catalog`, `runs`, `detail`, `launch` and `cancel`; it does not supply a workspace-key transport or replace wallet verification/action proofs.

There is no training, public run/RL monitoring, account/key-management or worker-lease client/OpenAPI export. Their supported platform HTTP surfaces belong to the [public HTTP reference](https://app.reliqua.ai/docs/api-reference/overview). The native operator flow is outside the customer OpenAPI contracts.

## Examples and verification

- [Generation and browser client usage](../README.md#generation) starts with discovery and requires explicit review before order creation.
- [CPU validation](../examples/validate-dataset.mjs) uploads an owned input and creates a real bounded job using retained UUIDs; it provisions no worker.
- [Checkpoint evaluation](../examples/evaluate-checkpoint.mjs) prepares a private journal; submission requires an explicitly approved aggregate ceiling.
- [Benchmark export](../examples/export-checkpoint-benchmarks.mjs) and its [Python bridge](../examples/export-checkpoint-benchmarks.py) require verified reports, reviewed publication evidence and a dedicated evaluation run.

Run `npm ci` and `npm test` on Node.js 22 or later. Tests resolve internal schema references, compare operation/security contracts and validate synthetic examples through runtime parsers. The package test installs a local packed artifact and exercises clients/CLI against a local server; it makes no production request.
