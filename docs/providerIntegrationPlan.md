# Local provider integration implementation plan

Goal: fal.ai media generation, locally authenticated Codex agents, and account-free local onboarding.
Spec: providerIntegrationDesign.md, approved in conversation; additionally remove local Toonflow sign-in/account entry points.
Architecture: extend existing provider and agent infrastructure; preserve API providers and user data.
Execution: inline using the executing-plans workflow. The dedicated fork checkout and feature branch provide isolation from the original VideoFlow checkout.

Constraints: camelCase filenames; use @toonflow/file; no added test modules per AGENTS.md; do not delete production files or records. No changes to tenant billing/authentication.

## Review focus

No duplicate fal submission during resume; no secrets in checkpoints/errors; local authentication never copied; conversation changes cannot resume stale Codex context; missing Codex must not prevent startup or API provider use.

## Tasks

- [x] Add packages/providers/src/media/fal.ts and register it in packages/providers/index.ts. Map FLUX Schnell images and Veo 3.1 Fast text/image video to official fal schemas; persist accepted queue metadata; resume/poll with cancellation and deadlines. Verify provider typecheck and build integration.
- [x] Add apps/server/src/utils/codex local stdio client and session runner. Discover authentication/models via app-server. Expose local backend settings and model choices without requiring a cloud API key. Reuse wrapped Toonflow tools and session history; stream events; retain Codex thread bindings; handle interrupts and errors. Verify server typecheck/build and local protocol operations without paid turns.
- [x] Update local onboarding/settings to remove Toonflow account, wallet, hosted provider promotion, and publishing/market entry points requiring that account. Keep local installation and API provider capabilities. Add Codex connection status/refresh and fal setup guidance. Verify web typecheck/build and browser flow.
- [x] Document setup and validation limitations, review the full diff, and deliver the changes on the fork branch.

Verification results and limits: integrationValidation.md. Independent review findings were addressed: stale branch bindings now force a new thread, background discovery cannot block API catalogs, and unsupported local queue/steering controls are disabled.
