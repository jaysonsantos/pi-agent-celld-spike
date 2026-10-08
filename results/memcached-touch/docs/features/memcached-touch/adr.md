# ADR: add memcached `touch`

## Status

Accepted

## Context

The package implements binary commands in `Protocol`, with `ClientMixin`, `ReplicatingClient`, and `DistributedClient` providing the public API. `Client` is an alias for `ReplicatingClient`. Existing `delete` implementations establish key conversion, request dispatch, and client routing. Touch uses opcode `0x1c` and carries a four-byte expiration extra followed by the key; it does not require value data. The requested result differs from delete's missing-key behavior: a missing item must return `False`. Existing storage and increment/decrement operations convert negative expiration values to `MAXIMUM_EXPIRE_TIME`. Project release notes are generated from Conventional Commits rather than maintained by hand.

## Decision

Add a protocol-level `touch(key, time)` operation and surface it through the shared client API. Build a Touch request with the registered opcode `0x1c`, the network-order unsigned 32-bit expiration extra, and key bytes produced by `str_to_bytes`; send no value and perform no fetch. Match existing expiration convention by translating negative `time` to `MAXIMUM_EXPIRE_TIME`, while passing non-negative values through to unsigned packing. Return `True` for protocol success and `False` for key-not-found or server-disconnected responses, and preserve existing exception handling for other unexpected statuses.

Implement `ReplicatingClient.touch` by forwarding to every server and aggregating with `any`, matching its `delete` behavior. Implement `DistributedClient.touch` by selecting `_get_server(key)` and forwarding key and time, matching its `delete` routing. The `Client` alias requires no separate implementation. Document the method for users and via its API docstring. Add real-server coverage for return values and value preservation, plus client dispatch coverage. Do not manually edit `CHANGELOG.md`; the release workflow derives entries from commits.

## Alternatives considered

- **Fetch then rewrite the item with a new expiration:** rejected because it reads and changes the value, adds unnecessary protocol operations, and risks overwriting concurrent updates.
- **Expose only the protocol method:** rejected because the feature is requested as a library API and must work consistently through each public client class.
- **Use the existing delete result semantics for a missing key:** rejected because the required Touch result is `False` when no item exists.
- **Add stricter time validation or a new negative-time rule:** rejected to avoid introducing expiration behavior inconsistent with existing commands. The binary unsigned field remains the final constraint for non-negative values.
- **Manually add a changelog entry:** rejected because repository guidance states Commitizen generates changelog content from Conventional Commits.

## Consequences

- Callers can extend expiration without loading or replacing the cached value.
- The new method shares established key encoding, negative expiration handling, and client routing patterns.
- Replicated calls report success if at least one configured replica reports success; distributed calls report the selected server's result.
- Time remains required, and values not representable by the unsigned protocol field retain the existing packing failure behavior rather than gaining new validation.
- Users learn about the API in the documentation; release notes continue to be produced through the existing commit-based workflow.
