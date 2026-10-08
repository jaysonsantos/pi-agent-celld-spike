# Research: memcached `touch`

## Summary

The package implements the memcached binary protocol in `Protocol`, with public client classes layered over it. `Client` is a backward-compatible alias of `ReplicatingClient`; the three named public classes therefore require implementation in the protocol, replicating client, and distributed client (and the mixin declaration). The repository has real-memcached integration tests, Sphinx documentation, and a `CHANGELOG.md`.

## Relevant code (with file paths)

- `bmemcached/protocol.py`: `Protocol.COMMANDS` registers binary opcodes and packers. `Protocol.delete` demonstrates request construction, key conversion with `str_to_bytes`, response status handling, and disconnected-server behavior. Expiration-bearing storage commands in `_set_add_replace` and `_incr_decr` provide context for expiration packing and negative-time conventions. A Touch request carries the key and a 4-byte expiration extra; it does not need a value or value decode.
- `bmemcached/client/mixin.py`: shared client API surface and common construction of `Protocol` instances. `delete` is declared here as an abstract placeholder.
- `bmemcached/client/replicating.py`: `ReplicatingClient.delete` forwards the same key/CAS to each server and returns `any(...)`. `Client` points to this class in `bmemcached/client/__init__.py`; `bmemcached/__init__.py` exports `Client`, `ReplicatingClient`, and `DistributedClient`.
- `bmemcached/client/distributed.py`: `DistributedClient.delete` chooses a server using `_get_server(key)` and forwards the key. This is the corresponding server-selection path for a single key.
- `test/test_simple_functions.py`: real-server command integration tests use `unittest.TestCase`, discovered and run by pytest. The fixture client is `bmemcached.Client` against `/tmp/memcached.sock`; existing tests cover basic set/get/delete behavior and value checks.
- `test/conftest.py`: session-autouse fixtures launch required memcached daemons on TCP ports 11211 and 5000 and a Unix socket at `/tmp/memcached.sock`; optional fixtures cover IPv6 and SASL.
- `test/test_distributed_client_hashing.py`: client routing/hash selection tests and mocked dispatch tests. Useful precedent for confirming forwarding to selected/all servers.
- `docs/intro.rst` (also the `README.rst` symlink): user-facing usage examples. `docs/bmemcached.client.rst` and `docs/bmemcached.rst` use Sphinx autodoc, so public method docstrings are included in generated API docs. `docs/index.rst` builds the Sphinx tree.
- `CHANGELOG.md`: hand-organized historical release notes. `AGENTS.md` notes that Commitizen builds the changelog from commits, so check the project’s release convention before adding a feature entry.

## How the tests run

Install editable package and test/lint groups as described in `CONTRIBUTING.md` (`python -m pip install -e .` and `python -m pip install --group test --group lint`). Run `pytest -s` for the suite; it requires `memcached` on `PATH` and starts real processes using fixed endpoints. In particular, the required autouse fixtures fail if endpoints are occupied or the executable is missing. Optional IPv6/SASL tests may skip if system support is unavailable. `tox` runs pytest plus `ruff check .` and `ruff format --check .` across Python 3.10–3.14; docs build with `cd docs && make html`.

## Constraints and risks

- Preserve protocol framing: Touch uses opcode `0x1c` and a 4-byte network-order expiration extra, with key bytes in the body. It must not read or rewrite the value; validate by checking the stored value remains unchanged as well as return behavior.
- Distinguish Touch’s requested semantics (true only on success/existing key, false for missing key) from `delete`, which deliberately treats a missing key as success. Handle server-disconnected status consistently with other single-command protocol methods.
- Keep the existing key conversion (`str_to_bytes`) and route/replication behavior aligned with `delete`. ReplicatingClient’s `any` aggregation means a replicated touch can return true when at least one server succeeded; a DistributedClient contacts only the hash-selected server.
- Expiration has existing conventions but no shared helper: set/add/replace and increment/decrement map negative times to `MAXIMUM_EXPIRE_TIME`, whereas `flush_all` packs time directly. Confirm the desired time range/convention for Touch and keep unsigned 32-bit packing valid.
- Integration tests need isolated keys and should avoid fragile sleep-based expiration assertions. Adding protocol-level framing tests may help catch an incorrect extra length/opcode in addition to real-server coverage.
- `Client` is an alias, not a separate implementation; avoid redundant API logic while still exercising it through the public import.

## Open questions

- Should `touch` require `time` explicitly, as the requested signature suggests, or default it consistently with public `set`/`delete` APIs?
- Should Touch use the existing negative-expiration convention, and should any validation be added for values outside the unsigned 32-bit protocol range?
- Is a CHANGELOG entry expected for this change despite the documented Commitizen-generated changelog workflow?
