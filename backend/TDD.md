# Backend: test-first evidence

This is the historical red/green ledger for the named slices. Test counts
refer to those runs; current completion and verification results belong to
the [slice plan](../docs/work-plan.md) and [acceptance](../docs/acceptance.md).
Run the current backend suite from the repository root with
`pnpm test:backend`; link targets below identify the maintained test files.

## Stage two: red/green and promotion

The initial [draft HTTP contract](tests/test_draft_contract.py) started as
9 red cases against the existing real app and one green harness control.
Imports and HTTP execution worked; status/error assertions failed. Later
assertions were initially unreachable and were not claimed as separate red.

SQOCH-21: 27 configuration red cases became green; an additional unsupported
provider red became green (29 config tests total). SQOCH-22: 15 initial red
cases, then targeted red/green for no-op migration under a live lock and three
independent-review defects (foreign/incomplete DB). Storage has 22 green tests.
Two postimplementation storage rollback/reset tests are regression evidence.

SQOCH-23: the 9 draft cases became green, then 8 flow cases reached preview/
confirm red and became green. Subject CR/LF and non-string date input also
had explicit red/green. Concurrency, transaction rollback, clock boundary,
immutability and local HTTP guard checks were added as regressions.
[test_campaign_flow.py](tests/test_campaign_flow.py) and draft tests now contain
38 cases in the normal suite. Pending files/control/commands were removed;
the previous temporary exclusion from verify has ended. No skips or xfail.

An independent review then reproduced a mixed GET/list snapshot during a
concurrent confirm. Two barrier tests failed (draft with eight deliveries),
explicit read transactions fixed the defect, and both became green.
The trim/maximum-length boundary then had two additional red/green cases.
At SQOCH-23 completion the backend suite had 187 passing tests. See
[contract](../docs/notifications-contract.md), [slice plan](../docs/work-plan.md)
and [acceptance](../docs/acceptance.md) for later results and review gates.

SQOCH-24: the delivery boundary has 58 targeted tests across
[test_claim.py](tests/test_claim.py), [test_smtp.py](tests/test_smtp.py),
[test_progress.py](tests/test_progress.py), [test_reconcile.py](tests/test_reconcile.py)
and [test_worker_process.py](tests/test_worker_process.py). Independent review
reproduced two defects with real smtplib: LF framing changed stored MIME, and
a local DATA-response parser failure was mistaken for a definitive 500 refusal.
Five added failing cases became green after CRLF serialization and conservative
unknown classification. A real Mailpit reproduction changed from mismatch to
matched without weakening comparison. Later real SMTP/process acceptance is
regression evidence in [test_delivery_acceptance.py](integration/test_delivery_acceptance.py).

SQOCH-25: 43 AI cases cover the bounded tool loop, strict final JSON,
revision checks and unchanged draft on failure. Review-driven date rejection
cases and four real-shaped provider-index cases went red before their fixes.
The complete backend suite then had 288 passing tests. Live DeepSeek prepare
and rewrite are separate integration evidence; deterministic tests use an
HTTPX transport double, not a replacement application.

SQOCH-26: [Organizer.test.tsx](../src/features/organizer/Organizer.test.tsx)
and [api.test.ts](../src/features/organizer/api.test.ts) cover the organizer
controller and transport. Six additional review-driven failures (successful
and unsuccessful load retries, stale polling warnings after reconciliation)
became green after their fixes. The frontend suite then had 112 passing tests,
including the unchanged booking cases. Browser tests in
[organizer.spec.ts](../e2e/organizer.spec.ts) include four real UI/API/SQLite
scenarios and two controlled-HTTP screen scenarios. The initial browser cases
were written after those boundaries existed and are acceptance/regression
evidence, not a claim of test-first UI architecture. Three later reproduced
scenarios went red before fixes: Mailpit underline, long-subject overflow and
a stale resume notice after completion. The four new targeted browser cases
(two screen scenarios on two projects) and component notice case are green.

SQOCH-28: independent review reproduced inherited Compose operator settings in
the Mailpit runner. The new [runner test](../scripts/test-mailpit.test.mjs)
went red, then green after pinning compose.yaml/cwd/empty env-file and clearing
COMPOSE_* variables. Real Mailpit acceptance passed again. The full verify
passed 112 frontend +288 backend +28 tooling +64 E2E =492 tests; clean-copy
and final review evidence belong to the acceptance document.

SQOCH-31 organizer UX follow-up: three real HTTP list-summary cases went red
on missing subject/proposed_start, then green. Ten UI/transport cases went red
before the initial UX fixes; an independent-review conflict case and a browser
viewport failure had separate red/green cycles. Final evidence belongs to the
[UX audit](../docs/history/reviews/organizer-ux-20261027.md) and current acceptance. Booking behavior
was not edited.

## Stage one: historical evidence

Historical evidence from 22 October 2026; times below are UTC. Maintained tests:
[test_orders.py](tests/test_orders.py), [test_confirmation.py](tests/test_confirmation.py),
[test_delivery.py](tests/test_delivery.py).

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
