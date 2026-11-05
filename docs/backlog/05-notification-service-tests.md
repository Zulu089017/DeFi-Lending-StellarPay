# Add a test suite for the notification service

**Labels:** `good first issue`, `testing`, `S` **Drips:** fundable — an ideal
first contribution: one file, one package, no protocol context needed.

## Problem

`services/notification` ships a WebSocket server
(`services/notification/src/websocket.ts`) whose `test` script is literally
`echo 'no tests yet'`. The package type-checks and builds, but **nothing**
verifies its behaviour, so a regression in the broadcaster would not be caught
by CI.

## Scope

1. Add a `vitest` test suite for `services/notification/src/websocket.ts`.
2. Cover the message fan-out: a client connecting, receiving a broadcast event,
   and disconnecting cleanly.
3. Cover the failure path: a client that is not ready or has closed must not
   crash the server.

## Acceptance criteria

- [ ] `services/notification/package.json` has a real `test` script
      (`vitest run`) and the matching dev dependencies (matching the versions
      used by the other services).
- [ ] The package is included in the `pnpm test` turbo run (it already is — the
      task must now execute real tests instead of the `echo` placeholder).
- [ ] At least three tests: connect, receive a broadcast, and a closed-client
      case.
- [ ] `pnpm --filter @stellar-payment-gateway/notification test` passes and the
      count is reported in the PR description.
- [ ] `docs/feature-evidence.md` § 3 changes the notification row from
      "source-verified only" to "verified".

## Verification

```bash
pnpm --filter @stellar-payment-gateway/notification exec tsc --noEmit
pnpm --filter @stellar-payment-gateway/notification test
pnpm test
```

## Out of scope

- Adding new notification channels (email, push).
- Changing the event payload shape (that is `services/indexer`'s contract).

## References

- [`services/notification/src/websocket.ts`](../../services/notification/src/websocket.ts)
- [`services/payment/tests/`](../../services/payment/tests) — the pattern to
  follow
- [`docs/feature-evidence.md`](../feature-evidence.md) § 3
