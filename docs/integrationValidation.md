# Integration verification

Verified on 2026-11-16 in a Linux arm64 source checkout, using isolated temporary data/workspace directories.

## Passed

- Provider TypeScript compilation: `bun x tsc -p packages/providers/tsconfig.json`.
- Production web/server builds: `bun run build` in each app directory.
- Individual canvas/workspace tool and text/image/video node builds.
- Real local Codex app-server initialization, authentication detection, model discovery (eight models), and dynamic-tool thread setup.
- Main `/api/agent` streaming response, continued conversation recalling its prior response, and one successful workspace `ls` call.
- `/api/ai/generate` response and an SDK-managed AgentSession response through local Codex.
- Normal continuation retained the same Codex thread. Rewinding to an earlier branch created a different thread.
- In-flight cancellation returned in approximately one second.
- Missing executable returned an empty catalog in 27 ms. Slow background discovery has a separate 1.5-second catalog budget.
- fal source validation through the real host parser and VM loader; missing-key handling rejected generation before submission.
- Fresh server media-provider listing contained only fal, three models, and no load error.
- Browser navigation from account-free onboarding to the project screen and provider settings; local account/wallet/marketplace categories were absent.
- Independent source review completed; stale branch bindings, startup probe latency, and unavailable queue/steering controls were addressed.

## Limits

- Full server/web typechecks report the upstream missing generated file `.hutch/devkit/api/config/ElectrobunConfig`; no remaining integration-specific diagnostics appeared. This is not a clean full typecheck.
- No live fal generation was performed: no key was configured and no fal charges were incurred. Queue mapping was checked against official documentation and reviewed in source; paid generation/recovery require a live check with the user's key.
- The UI detector reported the preexisting Inter font in onboarding; the existing visual system was retained.
- No test modules, mocks, fixtures, test dependencies, or CI test workflows were added, per AGENTS.md.
