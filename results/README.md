# Results

Each folder has the output of one pipeline run, as the worker API gave it after the run.

| File | Source |
|---|---|
| `status.json` | `scripts/api.sh GET /features/<name>` |
| `artifacts.json` | `scripts/api.sh GET /features/<name>/artifacts` |
| `<name>.patch` | `scripts/api.sh GET /features/<name>/artifacts/patch` |
| `docs/features/<name>/*.md` | The documents that the agents wrote in the checkout. |

Apply a patch to a clean checkout of the project:

```sh
git checkout -b feature/memcached-touch origin/main
git apply --index path/to/results/memcached-touch/memcached-touch.patch
```
