# Repository Guidelines

A spike: Pi Durable on celld, with OpenSandbox as the execution environment, as one Helm chart.
`README.md` tells how to run it. `docs/architecture.md` tells why it has this shape.

## Paths

| Path | Purpose |
|---|---|
| `Chart.yaml`, `values.yaml`, `templates/` | The Helm chart. The repository root is the chart root. |
| `vendor/opensandbox/charts/` | Copies of three OpenSandbox charts at the tag `release-1.1.0`. Do not edit them. |
| `charts/` | Packaged copies of the vendor charts. `helm dependency build` makes them; git ignores them. |
| `src/worker/` | The worker that celld runs: one Durable Object for each feature, and one object with the list of the features. |
| `src/worker/ui/` | The page that the worker serves at `/`: one HTML file. celld bundles it as text. |
| `src/worker/pipeline/` | The durable pipeline task, the agent roles and prompts, the documents, the scripted test model. |
| `src/worker/sandbox/` | The OpenSandbox client, the `ExecutionEnv` of Pi Durable, the sandbox setup. |
| `src/worker/storage/` | The Pi Durable storage adapter for the SQLite of a Durable Object. |
| `src/worker/tools/` | The restart-safe `bash` tool. |
| `src/gateway/` | The sidecar: the S3 shim for the object store and the proxy that adds the keys. It runs on plain Node.js. |
| `src/jobs/` | Small Node.js programs that the Jobs of the chart run. |
| `scripts/` | Scripts for the developer machine. |
| `scripts/in-cluster/` | Scripts that the Jobs of the chart run. The chart reads them with `.Files`. |
| `examples/` | Feature requests for `scripts/api.sh`. |
| `test/` | Unit tests on the Node test runner. |
| `wrangler.jsonc` | The worker config that `celld deploy` and `celld dev` read. |

## Commands

- Dev shell: `direnv allow`, or `nix develop`.
- Lint: `scripts/lint.sh`.
- Test: `scripts/test.sh`.
- Both: `scripts/all.sh`.
- Install or upgrade on the cluster: `scripts/install.sh`.
- Worker API: `scripts/api.sh GET /features/<name>`, `scripts/status.sh <name>`.
- Remove from the cluster: `scripts/uninstall.sh`.

## Rules

- Use pnpm, never npm. `esbuild` is a runtime dependency on purpose: the deploy Job installs with `--prod`, and celld needs `esbuild` for the bundle.
- Write TypeScript that Node.js can run with type removal only: no `enum`, no parameter properties, no `namespace`. The gateway and the jobs run from a ConfigMap without a build.
- Import with the `.ts` extension.
- Put no secret in a `vars` entry of the worker. celld keeps `vars` as plain text in the bucket. A key goes to the gateway sidecar through the Kubernetes Secret.
- Keep the worker free of Node.js built-in modules that celld does not have. The list is in `docs/cloudflare-compat.md` of celld.
- The templates read repository files with `.Files`. A new file that a template needs must not match `.helmignore`.
- Each file that `.helmignore` does not match goes into the Helm release record, which has a limit of 1 MiB. Add new top-level folders to `.helmignore`.
- A Job cannot change. The name of each Job has a hash of its inputs; keep each new input in that hash (`spike.deployId` in `templates/_helpers.tpl`, and `$jobSpec` in `templates/features.yaml`).
- A setup script of the sandbox takes the lock `TAKE_SETUP_LOCK` first (`src/worker/sandbox/provision.ts`). A setup command continues in the sandbox when the worker goes away, and the next worker starts it again.
- Keep one stored value below 2.2 MB. celld refuses a larger value, and a refused commit breaks the open Harness until it opens again.
- The OpenSandbox subcharts take the namespace, the Secret name, and the ConfigMap name as literal values. When you change one of these names, change `values.yaml` and `templates/_helpers.tpl` together.
- Never call Helm for this release without `--reset-then-reuse-values`; use `scripts/install.sh`. The chart default is the scripted model.
- Never change the model of a live pipeline in code. A pipeline keeps the model of `FeatureDoc.model`, and `#modelConflict` in `src/worker/feature-agent.ts` stops a pipeline on a deployment with a different model.
- Each phase of the pipeline must be safe to run again. A phase can stop at each `await`.
- A new round (`FollowUp`) uses the conversations of the earlier pipeline and does not own them. When code stops a pipeline, call `#stopAgents` in `src/worker/feature-agent.ts` also.
- Never make or repair a sandbox outside a pipeline. After the end of a pipeline, an agent gets the sandbox only as it is.
- Keep the page in one HTML file without external files. The chart puts it into a ConfigMap with the worker sources.
- Write each text of an agent into the page as text or through `esc()`. A transcript holds text that a model wrote.
- Run the scripts with bash. `scripts/common.sh` does not work when zsh reads it with `source`.
- Never let a pipeline phase throw for a failure that can go away. Use `guarded()`; an uncaught throw ends the task for good.
- Put a pause of 30 seconds or more in a loop that calls `kubectl`. The control-plane node of the cluster is slow.
- Do not commit `.envrc` or `.env`.

## Facts about the outside systems

### The object store

- The object store of this spike is a Ceph RADOS Gateway. It accepts `If-Match` on a `PUT` only with an ETag without quotes.
- It ignores a condition on `DELETE` and on `CompleteMultipartUpload`.
- celld does not start on it without the S3 shim: `celld diagnose` reports "the store rejected a conditional update that carried the current token".
- A write from the cluster takes 0.1 to 3 seconds.

### celld 0.6.1

- celld loads the worker from the bucket (`<prefix>/deploy/`). A running node takes a new deployment in 30 seconds and stops the old code after 60 more seconds. The alarm of each active feature then starts the object again.
- A node stops itself with exit code 3 and the log line `SELF-FENCE` when it cannot renew its lease in `CELLD_TTL_MS`.
- A node with a fixed `CELLD_NODE` takes its cells back at once after a restart.
- A Durable Object keeps its pending work after the handler returns. An object with an alarm in the next hour stays in memory.
- An outbound `fetch` has a total time limit: `CELLD_FETCH_TIMEOUT_S`, 120 seconds by default.
- `celld dev` watches the project folder and restarts the worker on each file change. Write no log file into the project folder, or use `--no-watch`.
- The release image has no esbuild and no shell tools for a build. The deploy Job copies the binary into a Node.js container.
- A `rules` entry of `wrangler.jsonc` must not have the key `fallthrough`. celld stops the deployment for that key.
- A Durable Object can call another object through its stub. celld holds each output of an object until the writes of that object are in the bucket.
- `celld dev` keeps all objects in one SQLite file. On 2026-10-08, on a machine with a high load, a write failed there with "database is locked", and the cell lost its database. For a test with a sandbox, run a node on a test prefix of the bucket.

### Pi Durable 1.0.4

- The package does not export the Durable Object storage adapter yet. `src/worker/storage/durable-object-sqlite.ts` is a port of the file in its repository.
- A task phase that throws ends the task with the outcome `faulted`.
- A tool with `replay: "safe"` runs again after a restart; other tools give the model an `interrupted` result.
- `runtime.entry()` of a task reads only entries of the conversation of that task. Read an entry of another conversation inside `runtime.commit()` with `tx.entry()`.
- `conversation.submit()` with `whenBusy: "steer"` puts an input into a busy run after its current tool calls. Without it, the input waits for the end of the run.
- A run settles each of its inputs with the same answer. So a message of the user during a step does not change how the pipeline gets the answer of that step.
- A conversation takes input after its owner task ended. The abort of a later task does not reach that conversation.

### OpenSandbox 1.1.0

- The server gives each sandbox a random id. The worker finds the sandbox of a feature by the label `feature=<name>`.
- The proxy of the server answers HTTP 404 with the code `K8S_POD_IP_NOT_AVAILABLE` while a sandbox pod starts. Only the execd code `FILE_NOT_FOUND` means that a path does not exist.
- The move call of execd refuses a destination that exists.
- `GET /command/<id>/logs?cursor=<n>` takes a byte offset, although the API document calls it a line number.
- A detached command (`background: true`) writes stdout and stderr to one file.
- The upload API reads the `metadata` part as a file, so that part needs a file name.
- A sandbox pod that someone deletes comes back with the same sandbox id, a new address, and a new container file system. The volume stays.
- The first pull of an image through the registry proxy can fail one time with "internal server error". The kubelet tries again.
- The server logs "Informer watch error: (404)" each 30 seconds, because the Firecracker definitions are not installed. The sandboxes work.
