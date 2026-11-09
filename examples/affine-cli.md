# Affine batch workflow with the CLI

Requires Node.js 22 or later and client 0.12.0. Build the reviewed source and install its local tarball as described in the [package guide](../README.md#customer-developer-preview). Verify the artifact SHA-256 when receiving a handoff. Hosted release archives require their own matching verified release manifest. `reliqua --help` lists the installed commands. The SDK example in [affine-batch-pilot.mjs](affine-batch-pilot.mjs) implements the same stages.

Local review and planning work without an account or compute. Hosted execution requires an existing, owner-bound, qualified batch profile. It does not rent hardware, open a capacity window or claim an invitation. Actual prompt, rollout, reward, model and tokenizer bytes must already belong to the operator-approved frozen job. The upload below sends only its small metadata request. If capacity is closed, keep the request and contact the operator to qualify a new profile; an old successful run does not authorize another allocation.

## Review and plan locally

Use a complete official v1/v2 batch and its raw mining snapshot. Both commands reuse the SDK's pure checks, make no network request and write only stdout. Work in an owner-only private directory outside repositories; explicit shell redirection saves the returned records:

```bash
umask 077
reliqua affine review --batch batch.private.json --mining mining.private.json --hotkey PUBLIC_HOTKEY --json > review.private.json
reliqua affine plan --batch batch.private.json --mining mining.private.json --input plan-input.private.json --json > plan.private.json
```

Batch input is capped at 64 MiB, mining input at 1 MiB and plan metadata at 32 KiB; all must be regular UTF-8 JSON files. Use this exact metadata shape for `plan-input.private.json`, replacing the placeholders and example clock values with retained values:

```json
{"hotkey":"PUBLIC_HOTKEY","head":"HEAD_DESCRIPTOR_SHA256","reference":"REFERENCE_DESCRIPTOR_SHA256","master":"provided","seed":7,"prior":"provided","trainingResultAt":2000000001,"lastGreenDecidedAt":2000000000}
```

`head` and `reference` are lowercase 64-hex descriptor digests, not model repository names or Git revisions. `hotkey` must match the batch. `master` is `provided` or `bf16-bootstrap`; `prior` is `provided` or `env-average`. `seed` is a uint32; both clock values are Unix epoch seconds, with `trainingResultAt >= lastGreenDecidedAt >= 0`. Retain their real provenance; do not invent historical result times to produce a plan.

Review is structural only. Plan returns commands for review using the [pinned official kit](https://github.com/AffineFoundation/affine/blob/eaf1ad20e4d018c85b30f53e9807b2b9a6a75e25/miner/README.md); it does not execute them, validate tokenizer bytes, qualify hardware or prove live parity. Its public-prior comparison approximation is separate from official acceptance. See [the Arbos guide](arbos-affine.md) for skill import and the operator handoff.

## Connect the owner

Use the normal browser invitation/sign-in flow first. Create account-scoped keys for that same owner: `training:read` for status/results, `training:write` for request upload and launch, and a separate `resources:write` key for the saved draft. Keep keys in the environment or your existing secret manager, outside prompts, repositories and shell history.

```bash
umask 077
reliqua doctor --json
reliqua affine status --json
```

The CLI reads `RELIQUARY_TRAINING_KEY` (or `TRAINING_API_KEY`) and `RELIQUARY_RESOURCES_KEY` (or `RESOURCES_API_KEY`). `RELIQUARY_API_URL` optionally selects the API origin. Inspect `affineBatch.ready`, its profiles and its reason. The top-level `training` flag describes ordinary training and is separate from batch availability. A configured key or successful health check does not establish owner access or available compute.

Keep the exact operator-approved profile, its digest and environment digest independently of any later receipt. The profile pins the job, source closure, runtime, input inventory, mining snapshot, batch, head, reference, tokenizer, evaluator, seed, comparison clock, owner, expiry, output limit, cost ceiling and receipt public key. Never take the trust anchor solely from a downloaded receipt.

## Prepare and save

Run each selected stage once. All `--input` files must be regular UTF-8 JSON files of at most 32 KiB, stored privately outside a repository. The examples below use placeholders; replace them with the reviewed values and returned objects. Save each JSON response before proceeding.

`prepare.private.json`:

```json
{"profileDigest":"APPROVED_64_HEX_DIGEST","maxHours":2,"maxCostMicroUsd":25000000}
```

```bash
reliqua affine prepare --input prepare.private.json --json > prepared.private.json
```

This selects the approved profile without starting compute. The duration and USD-millionths ceiling must stay within that profile. Two hours is a limit, not a completion guarantee.

Create `upload.private.json` with the **exact** `request` object returned by prepare and a simple filename:

```json
{"request":{"schema":"affine-batch-request/v1","profileDigest":"APPROVED_64_HEX_DIGEST","jobDigest":"APPROVED_64_HEX_DIGEST","maxHours":2,"maxCostMicroUsd":25000000,"jobExpiresAt":2000000000},"filename":"batch-request.jsonl"}
```

```bash
reliqua affine upload --input upload.private.json --confirm-rights --json > uploaded.private.json
```

Only pass `--confirm-rights` after confirming rights for this request. The uploaded bytes are `JSON.stringify(request)` followed by one newline. Retain their SHA-256 as `requestSha256` before launch. Save the returned `file.id` as the dataset ID.

Create `draft.private.json` as `{ "prepared": <the entire prepare response>, "name": "Batch comparison", "requestKey": "<stable UUID>" }`. Retain this key and exact input before sending:

```bash
reliqua affine save-draft --input draft.private.json --json > draft-result.private.json
```

Save the returned `resource.id` and `resource.revision`. Its configuration remains bound to the approved request and one optimizer step. The resources key cannot launch training.

## Review cost and explicitly launch

The currently supported batch profile is an operator-funded pilot; a service-credit quote is not required for that mode. Where the server requires a quote, use `{ "draftId": "RETURNED_ID", "revision": 1, "datasetId": "RETURNED_FILE_ID" }` as `quote.private.json`, replacing revision with the returned revision:

```bash
reliqua affine quote --input quote.private.json --json > quote-result.private.json
```

Review the exact rate, maximum reservation and expiry. Do not treat an unavailable quote as approval, or substitute a different draft, dataset or revision.

Create `start.private.json`:

```json
{"submission":{"draftId":"RETURNED_ID","revision":1,"datasetId":"RETURNED_FILE_ID"},"requestKey":"STABLE_UUID_FOR_THIS_LAUNCH"}
```

Include `quoteId` inside `submission` only when required. After separate approval for this exact submission and ceiling:

```bash
reliqua affine start --input start.private.json --approve-execution --json > started.private.json
reliqua affine task --id RETURNED_TASK_ID --json
```

The CLI never retries a mutation, provisions capacity or polls automatically. A timeout or `outcome_unknown` can mean the action succeeded. Retain the original input and key; reconcile owned draft/task history using the existing account interfaces before any retry. Reuse the same key and exact inputs. Never use a new key to work around uncertainty. A queued task is not proof of allocation or completion.

## Verify and download the delivered result

Create `delivery.private.json` as `{ "taskId": "RETURNED_TASK_ID", "request": <original uploaded request>, "pins": { "profileDigest": "<retained digest>", "environmentDigest": "<retained digest>", "requestSha256": "<original uploaded byte hash>", "affineBatch": <entire approved profile> } }`. Do not reconstruct these pins from the result you are checking.

```bash
reliqua affine verify-delivery --input delivery.private.json --json
reliqua affine download --input delivery.private.json --directory ./verified-delivery --json
```

Both commands read the succeeded owned task, verify its Ed25519 receipt against the retained profile and pins, and stream the archive through size and SHA-256 checks. Download requires a **new** directory. It writes private `receipt.json`, `result.zip` and `verification.json`; a failed download cleans its new directory and never overwrites an existing one. Retry a download into a new directory after resolving the error.

A scientific RED result, negative gain or nullable estimator metric can still be an intact delivered result. `integrityVerified` means the signed delivery matches retained bindings; it does not rerun the estimator, attest live inference identity or prove improvement. `liveParity`, `officialAcceptance`, `nativeRewardVerified` and `chainSubmission` remain false. Preserve the request, approved profile, receipt, archive and verification record together.
