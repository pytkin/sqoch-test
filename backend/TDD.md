# Backend: test-first evidence

Historical evidence from 22 October 2026; times below are UTC. Current tests:
[test_orders.py](tests/test_orders.py), [test_confirmation.py](tests/test_confirmation.py),
[test_delivery.py](tests/test_delivery.py). Run from the repository root:

```sh
uv run --project backend --locked pytest backend/tests -q
```

| Cycle                           | Red                                                                                                            | Green                                                                    |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Quote/event, 11:57–11:58        | 41 behavioral assertions returned 404 instead of 200/422; executable tests preceded models, pricing and routes | 42 passed including the harness                                          |
| Confirm, 11:58–11:59            | Confirmation endpoint absent; 404 instead of 201/409/422, quote remained green                                 | 87 passed after repeat validation and calculation                        |
| Delivery, 12:00                 | Built HTML returned 404; contract export returned an empty object                                              | 91 passed after static delivery and deterministic export                 |
| Output contract, 12:02–12:03    | Always-serialized Event defaults were optional in OpenAPI                                                      | 92 passed with required serialized output fields                         |
| Independent review, 12:05–12:06 | Eight cases exposed group error location `body` instead of `body/participants`                                 | 92 passed after moving the invariant to the participants field validator |

The working harness was verified before application red. Import/discovery/setup
failures were not counted as behavioral red. Most business/API cases preceded
implementation; output-contract shape tests were added after models existed
and are regression evidence, not test-first model design. Later regressions
are included in the current [acceptance](../docs/acceptance.md).

Known limitation: Starlette TestClient emits an HTTPX deprecation warning.
Tests pass; warnings are not hidden and the runtime was not downgraded.
