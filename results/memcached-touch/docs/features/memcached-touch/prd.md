# Product requirements: memcached `touch`

## Problem

Clients cannot change a cached item's expiration without fetching or replacing its value. Memcached's binary protocol provides a Touch command for this purpose, but this library does not expose it.

## Goals

- Expose `touch(key, time)` through the protocol and public client APIs.
- Extend expiration on an existing item without retrieving or modifying its value.
- Follow existing key conversion and client-specific server selection behavior.
- Verify the feature against a real memcached server and document its public use.

## Non-goals

- Add a default value for `time`, new expiration validation rules, or a new expiration model.
- Add multi-key touch, CAS support, or fallback behavior that reads and rewrites the value.
- Add a hand-maintained changelog entry; this project generates its changelog from Conventional Commits.

## Requirements

1. `Protocol` MUST implement `touch(key, time)` using binary protocol opcode `0x1c`, with the expiration encoded as a four-byte network-order extra and the key encoded using the existing `str_to_bytes` handling.
2. A successful Touch response MUST return `True`; a key-not-found response MUST return `False`. A disconnected server MUST be handled consistently with other single-command protocol methods and return `False`; other unexpected statuses MUST follow existing protocol error behavior.
3. Touch MUST NOT issue a get or a storage command, and MUST NOT read, deserialize, or change the item's value.
4. The public `Client`, `ReplicatingClient`, and `DistributedClient` APIs MUST expose `touch(key, time)` and return a boolean. `Client` MUST retain its existing alias behavior as a `ReplicatingClient`.
5. Public client key handling and server selection MUST match `delete`: `ReplicatingClient` sends the operation to every configured server and returns whether any server succeeds; `DistributedClient` sends it only to the hash-selected server. The selected protocol method MUST receive the original key and time.
6. `time` MUST be required and expressed in seconds, matching the requested signature and the existing expiration-bearing commands. Negative times MUST use the established `MAXIMUM_EXPIRE_TIME` convention; non-negative values MUST be packed as the protocol's unsigned 32-bit expiration.
7. Real-memcached integration tests MUST cover an existing key, a missing key, and preservation of the stored value. Tests MUST exercise the public API; routing/replication forwarding should also be verified at the client layer.
8. User documentation MUST describe `touch(key, time)`, its seconds-based expiration, and its boolean result. API documentation MUST include the method through its public docstring/autodoc path. Do not add a manual `CHANGELOG.md` entry because release notes are generated from commits in this repository.

## Acceptance criteria

- Protocol tests or equivalent verification confirm opcode `0x1c`, the four-byte network-order expiration extra, key bytes, and result handling.
- Integration tests against real memcached prove `touch` returns `True` for an existing key and `False` for a missing key, while the existing key's value remains unchanged.
- Tests confirm replicating and distributed clients use the same target selection/aggregation pattern as their respective `delete` implementations, and that `Client` exposes the operation.
- Public user/API documentation explains the method; no hand-authored changelog entry is required under the project's generated-changelog convention.
