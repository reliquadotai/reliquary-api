# Use Arbos to coordinate an Affine batch pilot

Arbos can propose a supported math-task subset and coordinate the work. Reliquary's local operator workflow composes the official kit's exact-head generation, grading and batch export. Hosted execution is a separate path requiring a fresh owner-bound qualified profile for an already frozen batch. The official Affine kit owns batch construction, its one optimizer step and its comparison gate. Generic responses from another model are not a substitute for the required exact-head rollouts.

This guide uses client 0.11.2, the existing [Affine CLI workflow](affine-cli.md) and [official miner guide](https://github.com/AffineFoundation/affine/blob/eaf1ad20e4d018c85b30f53e9807b2b9a6a75e25/miner/README.md). It adds no generation engine or independent batch parser. Public source availability does not grant an account access or reserve compute.

## Connect Arbos

Install the reviewed client from source as described in the [package guide](../README.md#customer-developer-preview); do not guess an npm registry package. Use Node.js 22 or later. Import the existing workflow into Arbos's own skill library, substituting your local reviewed checkout and project name:

```bash
arbosctl skills add --file REVIEWED_CHECKOUT/skills/reliquary-affine-batches/SKILL.md --project PROJECT_NAME
arbosctl skills list --q affine
arbosctl skills show reliquary-affine-batches
```

Arbos imports Markdown with frontmatter. Its library selects relevant excerpts; ask it to read the full skill before execution. Copying files into an assistant-specific skill directory is not proof that Arbos loaded them. These commands match [Arbos's CLI](https://github.com/unarbos/arbos/blob/e445f70ad8893179db63bfbc1c749a089d56cb7b/crates/arbosctl/src/main.rs#L229); check the installed version's help if its interface differs.

Use Arbos's ordinary shell to run `reliqua`. Store scoped keys through its secret settings, never in a prompt, command argument or repository. A local CLI needs the actual key in its environment; Arbos's default secret placeholders are usable through its native `egress` tool, not directly as API keys. Let the owner decide whether to enable a real environment value for the CLI, restricted to this project. Prefer read-only authority for inspection and keep cost approval explicit.

Native MCP setup is a separate integration choice. Arbos's reviewed workspace initialization writes its own internal MCP configuration; this guide does not assume that adding Reliquary to that configuration persists or works. The shell/CLI route avoids requiring an Arbos change. See [Arbos configuration](https://github.com/unarbos/arbos/blob/e445f70ad8893179db63bfbc1c749a089d56cb7b/crates/arbos-agentd/src/workspace.rs#L896) and [secret handling](https://github.com/unarbos/arbos/blob/e445f70ad8893179db63bfbc1c749a089d56cb7b/crates/arbos-agentd/src/vault.rs#L15).

## Inspect availability before proposing a run

```bash
reliqua capabilities --json
reliqua doctor --json
reliqua affine status --json
```

Public readiness can report unavailable products or empty pilot catalogs. It does not answer whether this owner has a qualified Affine profile. With the owner's training key, inspect `affineBatch.ready`, its returned profiles and reason. An empty list means stop preparation and request qualification through the existing owner/operator channel. A configured key, installed skill or old successful delivery is not a current allocation.

## Freeze the task mix and hand it to the operator

Give Arbos a bounded research brief: the supported public math tasks to emphasize, the fixed total rollout budget and seed, the exact current head and reference, and the result to measure. Have it produce a proposed mix for review before any generation. Keep the plan, dataset bytes, mining snapshot, model/tokenizer identities and raw results in a private directory outside every repository, with owner-only permissions.

The existing generation stage selects indexes from the official math task pool; it does not accept arbitrary environments, DAPO tasks or custom prompts. The operator must confirm support for that exact subset and run the existing local generation stage against the exact-head server. This delegates generation, grading and batch export to the official kit; no response-conversion adapter or parallel generator is required. For hosted comparison, freeze the resulting batch's input inventory, source/runtime closure, evaluator, head/reference, sample/draw semantics, expiry, cost ceiling and receipt trust anchor. Have the operator return the independently retained qualified profile and digests for the intended owner.

For an existing official batch, use the local commands below. Their shared SDK functions provide structural review and a portable command plan without credentials, network access or compute. Keep the original batch and mining bytes outside repositories; outputs go to stdout, and the explicit redirects below save private records:

```bash
reliqua affine review --batch batch.private.json --mining mining.private.json --hotkey PUBLIC_HOTKEY --json > review.private.json
reliqua affine plan --batch batch.private.json --mining mining.private.json --input plan-input.private.json --json > plan.private.json
```

The [CLI guide](affine-cli.md#review-and-plan-locally) gives the exact plan-input shape. Review and plan do not run the official tokenizer, prove the head's identity or qualify execution. Generated commands are a plan for review, not executed instructions; the official kit remains the next validation authority.

**Current hosted boundary:** the public CLI selects an already qualified, pre-frozen batch. Its upload sends a small metadata request, not a newly chosen task mix or raw rollout files. There is no dynamic task-mix generation endpoint implied by this guide. A different mix or new head needs a newly frozen, qualified job before the hosted stages below can run.

## Submit and verify the qualified job

Follow [the CLI guide](affine-cli.md) for each input file's exact shape, stable request keys and retained verification pins. Work from the private directory; the following names refer to those reviewed inputs:

```bash
umask 077
reliqua affine prepare --input prepare.private.json --json > prepared.private.json
reliqua affine upload --input upload.private.json --confirm-rights --json > uploaded.private.json
reliqua affine save-draft --input draft.private.json --json > draft-result.private.json
```

Review data rights before upload. Save each returned object and construct the next input from those values. Review the profile's cost ceiling; if the returned billing policy requires a quote, obtain and review it using `reliqua affine quote`. After separate approval of the exact submission:

```bash
reliqua affine start --input start.private.json --approve-execution --json > started.private.json
reliqua affine task --id RETURNED_TASK_ID --json
```

Do not automatically retry an uncertain mutation, replace its request key or start another allocation. Read the existing owned task first. Once it succeeds, use the original request and independently retained profile pins:

```bash
reliqua affine verify-delivery --input delivery.private.json --json
reliqua affine download --input delivery.private.json --directory verified-delivery --json
```

The download directory must be new. Preserve the approved plan, request, profile, receipt, archive and verification record together. Inspect the official kit's checks and comparison result from the qualified execution. If the agreed handoff stops at batch export, the operator runs the official one-step and comparison stages separately; do not repeat a step already performed by the hosted job. A signed delivery proves its bindings, not model improvement, live parity, official acceptance or a chain submission.

## Test whether the coordination helps

Start with one small paired pilot: the usual operator-chosen task mix versus Arbos's proposed mix. Freeze both plans before observing results. Hold the initial head/reference, evaluator, rollout budget, sampling settings, training step and comparison clock fixed where the official protocol permits; record any unavoidable difference. Use separate qualified jobs and approvals for the two arms.

Compare accepted useful rollouts, total cost, wall time including handoff, and the official comparison result. Keep held-out evaluation out of mix selection. Treat one pair as a feasibility result, not statistical proof of improvement. If Arbos does not reduce coordination time or improve useful yield at the same budget, use the upstream kit directly. An intact delivery with a RED gate or negative gain remains a valid result.
