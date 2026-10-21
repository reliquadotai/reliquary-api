"""Optional Public API writer for one already-created evaluation run."""
import hashlib
import json
import re
import sys

SUMMARY_KEY = "reliquary_run_benchmarks"


def require(condition):
    if not condition:
        raise ValueError("Unverified dedicated-run export")


def publish(payload, api_factory=None):
    target, envelope, previous = (payload[k] for k in ("target", "envelope", "previous"))
    require(all(isinstance(target.get(k), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", target[k])
                for k in ("entity", "project", "evaluation_run_id", "trainer_run_id")))
    require(target["approved"] is True)
    require(target["evaluation_run_id"] != target["trainer_run_id"])
    require(envelope["schema"] == "reliquary.run-benchmarks.v1")
    require(envelope["run_id"] == target["trainer_run_id"] and envelope["scope"] == "held_out")
    encoded = payload["envelope_json"].encode("utf-8")
    require(len(encoded) <= 512 * 1024)
    require(hashlib.sha256(encoded).hexdigest() == payload["envelope_sha256"])
    require(json.loads(encoded) == envelope)
    if api_factory is None:
        import wandb
        api_factory = lambda: wandb.Api(overrides={"base_url": "https://api.wandb.ai"}, timeout=30)
    path = "/".join(target[k] for k in ("entity", "project", "evaluation_run_id"))
    api = api_factory()
    # Reading both within this exact project binds the source; the trainer is never written.
    trainer = api.run("/".join(target[k] for k in ("entity", "project", "trainer_run_id")))
    run = api.run(path)
    require(trainer.id == target["trainer_run_id"] and run.id == target["evaluation_run_id"])
    require(run.job_type == "evaluation")
    current = run.summary.get(SUMMARY_KEY)
    if current != envelope:
        require(current == previous)
        run.summary[SUMMARY_KEY] = envelope
        run.summary.update()
    verified = api_factory().run(path)
    require(verified.id == target["evaluation_run_id"] and verified.summary.get(SUMMARY_KEY) == envelope)
    # Hash the original Node producer bytes, preserving its numeric representation.
    return {"verified": True, "evaluation_run_id": target["evaluation_run_id"],
            "envelope_sha256": payload["envelope_sha256"]}


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError("Export payload too large")
        payload = json.loads(raw)
        print(json.dumps(publish(payload), separators=(",", ":")))
    except Exception:
        print("Dedicated-run export was not verified", file=sys.stderr)
        sys.exit(1)
