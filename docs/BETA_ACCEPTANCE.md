# Beta Acceptance

AER Beta acceptance was run from integrated main at `42ebd6c` after BETA-00 through BETA-04 merged.
The rule for this pass was breadth-first: fix only observed material security, authority, data-loss, UNKNOWN, recovery, or repeated operational failures.

## Final integrated evidence

- Typecheck: PASS.
- Full tests: 122 total, 117 PASS, 0 FAIL, 5 environment SKIP for Unix-domain listeners in the execution sandbox.
- E2E: 4/4 PASS.
- BETA-03 bounded recovery: 29/29 operations succeeded, 2 restarts, 2 recoveries, 3 UNKNOWN transitions, 0 model polls, 0 operator interventions.
- Full Alpha benchmark: PASS.
- No new material code failure was observed in the integrated pass.

## Real second-device acceptance

Both endpoints ran the merged main tree (`42ebd6c`). PC2 restarted on the existing durable state before the smoke.

- `project.inspect`: intended device/project returned; about 273 ms; 2763 returned bytes.
- `file.read(remote-proof.txt)`: returned `AER_BETA44_REMOTE_PROOF`; about 103 ms; 1387 returned bytes.
- Foreign device ID was rejected before forwarding.
- Foreign project ID and conflicting project aliases were rejected by the remote daemon.
- In-flight disconnect returned `DAEMON_RESPONSE_UNKNOWN`, `status=unknown`, `effectState=unknown` at about 125 ms.
- PC2 durable events for that disconnect showed exactly one `remote.requested`, one `remote.completed`, and retries=0.

The remote path remains OpenSSH Unix-socket forwarding; no public relay, cloud control plane, fleet manager, or new application protocol was added.
## Client-visible metrics and baseline comparison

The representative six-call MCP presentation total was 24,509 bytes: 22,753 structured bytes plus 1,264 text bytes. The benchmark's duplicated-JSON comparison value is 48,380 bytes, so BETA-00's removal of full payload duplication remains effective in integrated main.

AER does not win every micro-operation. The current benchmark records materially fewer model-facing operations than its scripted RDC baselines, but direct RDC remains faster and smaller for trivial reads/commands. In the real remote cross-check, RDC accessed the same PC2 root/proof with much less transport overhead; that timing is not an apples-to-apples semantic RPC benchmark, so it is evidence of overhead rather than a precise speed ratio.

There is no empirical ACP execution-latency baseline in the current Beta benchmark. The repository contains ACP autonomous-policy configuration, but not a comparable active ACP execution path for this acceptance run. No ACP performance number is inferred or fabricated.

## Deferred hardening (#29)

The #29 backlog remains deferred because no item produced a material ordinary-dogfood failure in this pass:

- broader MCP header/routing, MRTR, Origin/Host/proxy, trace/baggage, compatibility and cache matrices: no observed Beta blocker;
- broader Plugin evaluation/publication and provider matrices: no observed Beta blocker and outside the current runtime acceptance path;
- longer handler stress: current bounded recovery passed with restarts and no operator intervention;
- broader artifact corruption and SQLite fault-injection matrices: focused authority/tamper/recovery tests are green; no observed data-loss or authority failure requires expansion now;
- broad sandbox/delegated-provider matrices: provider-zoo expansion remains a non-goal;
- latency/token micro-optimization: AER still loses to RDC on trivial operations, but this does not break effect truth, recovery, confinement, or the semantic-execution thesis;
- GitHub transport/review/pagination/rate-limit hardening remains in #26 as already scoped.

## Beta decision

No known material blocker remains from this acceptance run. Effect truth, verification, project/device confinement, durable recovery, and second-device execution all passed. Further hardening should remain evidence-driven rather than reopening the deferred matrix wholesale.
