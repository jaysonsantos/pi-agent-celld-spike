# Architecture

This document describes how the spike works, why it has this shape, and what the tests on the cluster showed.

## Goal

Run an agent harness that implements a feature in a project, and that continues after its pod is gone.

- The harness is [Pi Durable](https://github.com/earendil-works/pi/tree/main/packages/durable) 1.0.4.
- The database is [celld](https://github.com/denoland/celld) 0.6.1. celld keeps one SQLite database for each Durable Object in an S3 bucket.
- The execution environment of the agents is [OpenSandbox](https://github.com/opensandbox-group/OpenSandbox) 1.1.0.
- The bucket is `pi-agent-celld-spike` on an S3-compatible object store.
- One Helm release holds all parts, so one command removes them.

## Parts

```text
namespace pi-agent-celld-spike
+--------------------------------------------------+      +---------------------------+
| pod pi-agent-celld-spike-celld-0 (StatefulSet)   |      | S3-compatible store       |
|                                                  |      | s3://pi-agent-celld-spike |
|  celld                                           |      |   fleet/deploy/   worker  |
|   worker: one Durable Object for each feature    |      |   fleet/cells/<cell>/     |
|     Pi Durable Harness on the SQLite of the cell |      |     one database for each |
|        |                    |                    |      |     feature               |
|        | S3, quoted ETag    | HTTP, no key       |      +---------------------------+
|        v                    v                    |                  ^
|  gateway sidecar (Node.js)                       |                  |
|   127.0.0.1:9000 S3 shim: removes the quotes, ---+------------------+
|                  signs again with the real keys  |
|   127.0.0.1:9100 /llm      adds the model key ---+--> model endpoint
|                  /sandbox  adds the API key   ---+--+
+--------------------------------------------------+  |
                                                      v
+----------------------+     +---------------------------------------------+
| opensandbox-server   |---->| sandbox pod of feature-a-b-c                |
| opensandbox-         |     |   execd daemon, user dev, /workspace on the |
|   controller-manager |     |   PersistentVolumeClaim workspace-feature-  |
+----------------------+     |   a-b-c                                     |
                             +---------------------------------------------+
```

| Part | Source | Purpose |
|---|---|---|
| Worker | `src/worker/` | Runs in celld. Holds the Harness, the pipeline, and the HTTP API. |
| Gateway sidecar | `src/gateway/` | S3 shim for the object store, and a proxy that adds the keys. |
| Deploy Job | `templates/deploy-job.yaml`, `scripts/in-cluster/deploy-worker.sh` | Builds the worker and writes it into the bucket with `celld deploy`. |
| Submit Job | `templates/features.yaml`, `src/jobs/submit-feature.ts` | Sends each feature of `values.yaml` to the worker. |
| OpenSandbox | `vendor/opensandbox/charts/` | Makes one sandbox pod for each feature. |

## Persistence for each feature

A feature name maps to one Durable Object: `env.FEATURE.idFromName("<feature>")`.
celld gives each Durable Object its own SQLite database and its own key prefix in the bucket.

| State | Where | Scope |
|---|---|---|
| Transcripts, tasks, documents of Pi Durable | `s3://pi-agent-celld-spike/fleet/cells/FeatureAgent:<id>/` | One cell for each feature |
| Checkout and tool installs of the project | PersistentVolumeClaim `workspace-<feature>` | One claim for each feature |
| Worker code | `s3://pi-agent-celld-spike/fleet/deploy/` | Shared |

`feature-a-b-c` and `feature-c-b-a` thus share no state.
The status of a feature shows its cell and its object prefix: `scripts/status.sh <feature>`.
`<id>` is an HMAC of the feature name, so the prefix does not show the name.

## The pipeline

One durable task of Pi Durable (`app.feature-pipeline`, `src/worker/pipeline/task.ts`) drives five agents.
Each agent is one conversation with its own instructions and its own transcript.
All agents work on the same checkout in the sandbox of the feature.

```text
provision -> prepare -> research -> design -> implement -> test -> review -> finalize
                                                 ^            |        |
                                                 +--- FAIL ---+--------+
```

| Phase | Agent | Output |
|---|---|---|
| `provision` | none | The sandbox of the feature exists and its command daemon answers. |
| `prepare` | none | User `dev`, the clone on `feature/<name>`, the root setup, the user setup. |
| `research` | researcher | `docs/features/<name>/research.md` |
| `design` | architect | `docs/features/<name>/prd.md` and `docs/features/<name>/adr.md` |
| `implement` | implementer | Code, tests, and user documentation |
| `test` | tester | `docs/features/<name>/test-report.md` and a verdict line |
| `review` | reviewer | `docs/features/<name>/review.md` and a verdict line |
| `finalize` | none | The documents and the `git diff` go into the durable state. |

A `VERDICT: FAIL` of the tester or the reviewer starts a new round for the implementer, with the findings.
After `pipeline.maxRounds` rounds the pipeline ends with the verdict `needs-attention`.

## How the state comes back after a pod loss

1. Pi Durable commits each entry, each task checkpoint, and each document to SQLite before it shows them.
2. celld answers a write only after the write is in the bucket. A single node has no faster path.
3. While a pipeline runs, the Durable Object keeps an alarm 15 seconds in the future. celld keeps alarms in the bucket.
4. A new pod starts celld with the same node id (`CELLD_NODE` is the pod name of the StatefulSet).
   A node with a known id takes its cells back at once; it does not wait for the old lease.
5. celld fires the alarm. That event starts the Durable Object, and the object opens the Harness on the restored database.
6. `harness.resume()` runs each task that was not at its end. The pipeline continues at its last checkpoint.

Each phase is safe to run again:

- A prompt to an agent has a request id from the task and the checkpoint (`<task>:<phase>:<round>:<attempt>`). Pi Durable returns the same submission for the same request id.
- `provision` looks for a sandbox with the label `feature=<name>` before it makes one.
- `prepare` skips each step that is done.

### Commands that outlive the worker

The `bash` tool of Pi Durable is not replay-safe: after a crash, the model gets an `interrupted` result.
`src/worker/tools/durable-bash.ts` replaces it for a sandbox:

1. The tool starts the command as a detached process of the sandbox (`background: true` in the execd API).
2. The tool stores the command id as a memo of the tool task.
3. The tool reads the output with short polls. No request stays open for the full run time.
4. After a restart, the tool call runs again, finds the memo, and follows the same process to its end.

A command that takes 45 seconds thus gives one complete result, even when the pod of the worker is gone for a part of that time.
A crash between step 1 and step 2 starts the command a second time; that window is one commit long.

### A lost sandbox

Each agent phase checks the sandbox first (`SandboxProvisioner.state`).

- `missing`: the sandbox is gone or failed. The pipeline returns to `provision`, then continues at the same phase.
- `unprepared`: the sandbox has a new pod. The marker file `/var/run/pi-sandbox-prepared` is on the container file system, so a new pod does not have it. The pipeline returns to `prepare`.

`/workspace` is a PersistentVolumeClaim, so the checkout and the virtual environment stay.
Packages that `rootSetup` installed are on the container file system; `prepare` installs them again.

## The page and the messages of the user

The worker serves one page at `/` (`src/worker/ui/index.html`). The page calls the same HTTP API as the scripts.

| Part | Source | Purpose |
|---|---|---|
| List of the features | `src/worker/feature-index.ts` | One Durable Object with one row for each feature. |
| Conversation of an agent | `src/worker/chat.ts`, `GET /features/<name>/chat` | The entries of a transcript and the live state, as JSON. |
| Message of the user | `POST /features/<name>/messages` | Gives a message to an agent, or starts a new round. |

A Durable Object cannot list the other objects of its class.
So each feature object sends a short summary to the list object when one of its values changes.
The list is a copy for the page. The state of a feature stays in the object of that feature.

The page reads a conversation again each 2.5 seconds. It asks only for the entries after the last entry that it has.

A message has one of three results:

| State of the feature | Result |
|---|---|
| The pipeline runs, and the agent is busy | Pi Durable puts the message into the run after the current tool calls (`whenBusy: "steer"`). The agent continues its step, and the pipeline gets the answer of that step. |
| The pipeline runs, and the agent is idle | The agent answers the message in a run of its own. |
| The pipeline is at its end | A new round starts. With `mode: "agent"`, one agent answers the message, and no round starts. |

A new round is a second pipeline task of the same feature (`FollowUp` in `src/worker/pipeline/task.ts`):

- It starts at `implement`. The request of the user is a part of the prompts of the implementer, the tester, and the reviewer.
- It continues the round numbers of the earlier pipeline, and it has its own limit of rounds.
- It uses the conversations that the agents have. Each agent thus has the transcript of the earlier rounds.

The earlier pipeline task owns those conversations, so a stop of the new task does not reach them.
`#stopAgents` in `src/worker/feature-agent.ts` stops each conversation directly.

After the end of a pipeline, an agent that answers the user gets the sandbox only when the sandbox is ready.
Nothing makes or repairs a sandbox outside a pipeline.

An agent keeps the model that it started with (see D9).
A message to a feature with a different model than the deployment gets HTTP 409.

## Decisions

### D1. The Harness runs inside celld, not next to it

Pi Durable has a storage adapter for the SQLite of a Durable Object, and celld runs Durable Objects.
So the worker is a Durable Object, and each commit of the Harness is a local SQLite transaction that celld replicates.
The alternative was a Node.js pod with celld as a remote SQL service. That needs a network protocol for transactions, which neither project has.

Pi Durable 1.0.4 does not export that adapter yet; it is in the repository only.
`src/worker/storage/durable-object-sqlite.ts` is a port. Remove it when a release has `@earendil-works/pi-durable/storage/sqlite/cloudflare`.

### D2. An S3 shim in front of the object store

celld takes and renews ownership with conditional writes: `If-None-Match: *` and `If-Match: "<etag>"`.
The object store of this spike is a Ceph RADOS Gateway. Tests on the bucket on 2026-10-07 showed:

| Request | Answer of the store |
|---|---|
| `PUT` with `If-None-Match: *`, object exists | 412, correct |
| `PUT` with `If-Match: "<current etag>"` (quoted, as RFC 9110 says) | 412, wrong |
| `PUT` with `If-Match: <current etag>` (no quotes) | 200, correct |
| `PUT` with `If-Match: <stale etag>` (no quotes) | 412, correct |
| `DELETE` with `If-Match` | Ignores the condition |
| `CompleteMultipartUpload` with `If-None-Match: *` | Ignores the condition |

celld sends the quoted form, so `celld diagnose` fails on this store: "the store rejected a conditional update that carried the current token".
The shim (`src/gateway/s3-shim.ts`) removes the quotes. The client signed that header, so the shim signs the request again (`src/gateway/sigv4.ts`).
With the shim, `celld diagnose` passes: `ok bucket conditional write: create, reject-create, update, reject-stale`.
celld uses no conditional `DELETE` and no conditional multipart upload, so the two ignored conditions do not matter.

A side effect: only the sidecar holds the account key pair. celld itself gets placeholder keys.

### D3. The gateway holds the keys

celld has no secret store. A `vars` entry of the worker is plain text in the bucket.
So the worker calls `http://127.0.0.1:9100/llm` and `http://127.0.0.1:9100/sandbox`, and the sidecar adds the keys from the Kubernetes Secret.

### D4. One sandbox and one volume for each feature

OpenSandbox gives a sandbox a server-made id, so the worker marks the sandbox with the label `feature=<name>` and records the id.
The create request asks for the PersistentVolumeClaim `workspace-<name>` with `deleteOnSandboxTermination: false`.
The worker reaches the command daemon through the proxy of the OpenSandbox server, which follows a new pod address.

### D5. The agents work as a user, not as root

Some programs refuse to run as root; the tests of the first project start `memcached`, which is one of them.
`prepare` makes the user `dev` (uid 1000), and each agent command runs with that uid.
`rootSetup` of a feature runs as root, for package installs.

### D6. OpenSandbox charts are copies

OpenSandbox 1.1.0 publishes no chart repository. `vendor/opensandbox/charts/` holds `base`, `controller`, and `server` from the tag `release-1.1.0`.
The subcharts take a namespace only as a literal value, so `values.yaml` repeats `pi-agent-celld-spike` and the chart stops for a different namespace.

### D7. A long node lease

celld stops itself when it cannot renew its node lease (`SELF-FENCE`, exit code 3).
With the 10 second default, a slow write to the bucket stopped the node on the first day.
`CELLD_TTL_MS` is 60000 now. With one node and a fixed node id, a long lease has no cost.

### D8. A feature waits for the deployment of its chart revision

After `helm upgrade`, the node runs the old worker deployment until the deploy Job ends and the node takes the new one.
A feature that starts in that time would run with the old settings, for example the scripted model.
The chart gives each deployment an id (`spike.deployId`, a hash of the inputs of the deploy Job). The worker gets it as the var `DEPLOY_ID`.
The submit Job sends the id in the header `x-deploy-id`, and the worker answers 503 until it runs that deployment.

### D9. A pipeline keeps its model, and an upgrade keeps its values

The chart default is the scripted model, and Helm does not remember a `--values` file of an earlier upgrade.
A plain upgrade thus made a deployment with the scripted model. The worker then gave that model to each agent, also to the agents of a pipeline that a real model ran.
The scripted tester and reviewer always pass, so such a pipeline ended with `accepted` and with the fixed files of the script in the checkout.

Two changes prevent that:

- `scripts/install.sh` calls Helm with `--reset-then-reuse-values`. An upgrade keeps the values of the last install.
- The feature records the model of its pipeline (`FeatureDoc.model`). When the deployed model is different, the worker does not start the task scheduler for that feature. The status shows the reason in `blocked`.

## What the tests showed

All tests ran on the cluster on 2026-10-07 with the scripted model (`llm.api: faux`).
The scripted model gives fixed tool calls, so the tests cover the storage, the sandbox, the tools, and the recovery, but not the quality of a real model.

| Test | Result |
|---|---|
| celld on the object store without the shim | Fails the storage test of celld. |
| celld on the object store with the shim | Passes. A new node with an empty disk restored the state in 3 seconds. |
| Full pipeline for `faux-touch-1` | Verdict `accepted` after 2 rounds, 5 documents, patch collected. |
| celld stops itself during `provision` | The new process found the sandbox by its label and continued. |
| Pod replaced during the 45 second command of the implementer | The command result is complete: 45 lines and the pytest result. |
| `feature-a-b-c` and `feature-c-b-a` at the same time, celld pod killed with `--grace-period=0 --force` during both implement phases | Both ended with `accepted`. Each one has its own cell prefix in the bucket, its own sandbox pod, and its own volume. |
| Sandbox pod of `sandbox-kill-1` killed during the 45 second command | The tool call gave an error result. OpenSandbox made a new pod with the same sandbox id. The next tool call ran the setup again, and the command passed. The pipeline ended with `accepted`. |
| A feature from `features` in the values | The submit Job sent it, and the pipeline ran. |
| `scripts/recovery-test.sh harness` and `scripts/recovery-test.sh sandbox`, after the fixes of the review | Both print `PASS`. |
| Release changed to the real model while the scripted pipeline of `guard-test-1` ran | The status showed `BLOCKED`, the pipeline stayed in `implement`, and the feature used no token of the real model. |
| Release changed back to the scripted model | The blocked pipeline continued and ended with `accepted`. |
| `scripts/install.sh` without options, after an install with the OpenRouter values | The release kept the model and the feature. |

### The run with a real model

On 2026-10-07 the feature `memcached-touch` ran with `~openai/gpt-luna-latest` through OpenRouter.
The request is `examples/python-binary-memcached-touch.values.yaml`: add `touch(key, time)` to python-binary-memcached.

| Fact | Value |
|---|---|
| Result | `accepted` after 2 rounds. The tester rejected round 1. |
| Time | 14 minutes, from 10:15 to 10:29 UTC. |
| Change | `bmemcached/protocol.py`, the three client modules, `docs/intro.rst`, and three test files. 13 files with the documents. |
| Documents | `research.md`, `prd.md`, `adr.md`, `test-report.md`, `review.md` in `docs/features/memcached-touch/`. |
| Tokens | 1.85 million in total: 1.66 million read from the prompt cache, 23 thousand written by the model. |
| Pod kill | The celld pod was killed without grace at 10:19:16 UTC, in the implement phase. The feature worked again at 10:19:32. |
| Check after the run | The full suite in the sandbox: 289 passed, 3 skipped. `ruff check` and `ruff format --check` pass. |

`results/memcached-touch/` has the status, the documents, and the patch of that run.

An independent review of the code found 13 defects after these tests; none was in a path that the tests used.
The fixes are in the code: one setup run at a time (a lock in the sandbox and a shared promise in the worker), a clone that survives a kill, a 404 of the proxy that no longer reads as "file not found", new agent conversations for a pipeline that starts again, and a size limit for the stored artifacts.

### The tests of the page

These tests ran on 2026-10-08.

Three tests used the scripted model. They ran on one celld node on the developer machine, with a test prefix of the same bucket and the OpenSandbox of the cluster:

| Test | Result |
|---|---|
| A message to the implementer during its 45 second command | The message is in the transcript after the result of that command, in the same run. The answer of the step names it, and the pipeline continued. |
| A message to the tester after the end of the pipeline, with `mode: "agent"` | The tester answered. No pipeline started. |
| A new round, two times | Rounds 3 and 4 used the conversations of rounds 1 and 2. Both ended with `accepted`. |

One test used the real model on the cluster, from the page, for the feature `memcached-touch`:

| Fact | Value |
|---|---|
| Request of the new round | "Add a short touch() example to the README, next to the other usage examples." |
| Message during the implement phase | "Keep the example to four lines or less." The implementer got it 44 seconds after the request, and its answer says that the example has four lines. |
| Sandbox | The sandbox pod was a new one since the first run. So the round ran the setup again first, in 14 seconds. |
| Result | `accepted` in round 3, 4 minutes after the request. The tester reported 290 passed and 3 skipped tests. |
| Tokens | 0.93 million for the round. 0.78 million of them were cache reads. |

`docs/media/page-tour.webp` is the recording of that test.

## Scale

One celld serves all features. A new feature is one more Durable Object in the same celld, and one more sandbox pod.

| Part | How many |
|---|---|
| Harness pod: celld and the gateway sidecar | One for all features |
| OpenSandbox server and controller | One for all features |
| Bucket | One for all features |
| Durable Object, SQLite database, prefix `cells/<id>/` | One for each feature |
| Sandbox pod and volume `workspace-<name>` | One for each feature |

The rest of this section comes from the celld documentation and source. The spike ran one node, so these facts are not tested here.

- celld calls a Durable Object with its database a cell. The lock is for each cell, not for celld.
- Each cell has one owner node at a time. The owner record is `cells/<id>/own.json` in the bucket, and a node takes a cell with a compare-and-swap write.
- A request can arrive at each node. A node that does not own the cell passes the request to the owner through the internal listener.
- Each node keeps a lease in `nodes/<node>.json`. When a node stops and its lease ends, a different node takes its cells with the next epoch number and restores each database from the bucket.
- The data of each epoch has its own prefix. A late write of the old owner goes to a prefix that no node reads.
- With two or more nodes, a second node keeps a copy of each write on its disk, and the bucket gets the write later. celld gives approximately 25 ms for such a write, against 90 to 600 ms with one node.
- One cell runs on one node and on one thread. The unit of scale is thus the feature: more nodes hold more features, but one feature cannot use two nodes.

### StatefulSet or Deployment

Both work, because a celld node holds no state. Keep the StatefulSet and add replicas.

| | StatefulSet (this chart) | Deployment |
|---|---|---|
| Pod name | Fixed | New for each pod |
| Node id of celld | The pod name. A new pod has the id of the old one. | A new id for each pod |
| After a pod loss | The new pod takes its cells back at once. | A different node waits for the lease of the old node: up to `CELLD_TTL_MS`, 60 seconds in this chart. |
| Address for the other nodes | A fixed DNS name for each pod | A pod address that changes |

### What a second node needs

- More replicas in the StatefulSet.
- An internal listener on the pod address with an advertised name, in place of `127.0.0.1:8081`.
- A NetworkPolicy for that listener. Its operator API has no authentication.

One risk is open. Two nodes are safe only if the object store does the compare-and-swap correctly when two nodes write at the same moment.
The tests on the bucket covered one writer only, and celld lists other Ceph-based stores as not supported.
With one node, no second writer exists, so this risk does not apply to the current release.

## Limits

- One celld node. Each write waits for the bucket, which takes 0.1 to 3 seconds from the cluster.
- celld 0.6.1 is a beta release, and Pi Durable is experimental. Both can change their formats.
- The worker API and the page have no authentication. The Service is `ClusterIP` only. Each person that can reach the Service can read the transcripts and send a message to an agent.
- An agent that answers the user after the end of a pipeline can change files. The collected diff does not have that change before the next round.
- A feature from before the page is in the list after the first read of its status.
- execd in a sandbox has no authentication in OpenSandbox 1.1.0. Each pod of the cluster can reach it on the pod address.
- The bucket grows with each activation of a cell. celld removes old data only with `CELLD_LTX_RETENTION_SECS`, which is not set.
- OpenSandbox 1.1.0 names Kubernetes 1.21 to 1.34 as tested. The cluster runs 1.36, and the parts that this chart uses work.
- A `GET` for a feature that does not exist makes an empty cell in the bucket.
