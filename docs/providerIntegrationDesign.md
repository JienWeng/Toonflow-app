# fal.ai and local Codex integration

Status: approved in conversation. Scope includes removing local Toonflow sign-in, wallet, marketplace publishing, and hosted-provider promotion.

## Goal

Use fal.ai for media generation and the user's locally authenticated Codex installation for Toonflow agent conversations. The user confirmed local login reuse, rather than attaching to a preexisting conversation.

## Approaches and recommendation

For fal.ai, extend the existing media-provider contract rather than creating a parallel generation service. It already supports persistent provider task data and resume callbacks, which map naturally to fal's queue API.

For Codex, use a locally spawned `codex app-server` over stdio. A one-shot CLI subprocess is simpler but poorly suited to ongoing conversations, tool calls, approvals, and interruption. Copying login credentials into Toonflow's API-provider settings would couple the application to credential internals; retain authentication ownership in Codex instead.

## fal.ai

Register a built-in provider with server-side key configuration. Start with a deliberately supported image model and video model, verified against their official schemas before implementation. Advertise only supported modes and settings; arbitrary fal endpoints cannot share one assumed input schema.

Submit through the queue API, immediately persist the accepted request ID and non-secret recovery metadata, poll with cancellation, and map final outputs into the existing media asset contract. Resume the accepted request after interruption instead of submitting a new generation. Keep keys out of checkpoint files, browser responses, and errors. Existing workspace output persistence remains authoritative.

## Local Codex

Add an explicit local Codex agent backend alongside current API providers. The server launches the installed executable without a shell, checks authentication through the supported protocol, and surfaces missing installation/login errors. The local process runs on the same machine and OS account as Toonflow's server; remote browser access alone does not provide access to the browser machine's Codex login.

Create a Codex thread per Toonflow conversation and save its ID so subsequent turns resume it. Translate streamed text, tool lifecycle, completion, failures, and interruption into Toonflow's existing event flow. Expose Toonflow tools through a supported Codex tool bridge, preserving workspace boundaries and approval handling. Do not silently grant broad filesystem or command execution permissions. Discover available models rather than hardcoding the installed model catalog.

Local login reuse is a local deployment feature. Keep tenant billing and hosted user credential isolation outside this first integration.

In this first version, persistent local Codex conversations accept one turn at a time. Disable queue/steering controls while a Codex turn runs; Stop remains available. SDK-managed team/text calls use a stateless Codex adapter with full supplied context. No API request uses the internal SDK model placeholder URL.

## Acceptance and validation

- fal appears in provider settings and supported models are usable from media nodes.
- Accepted fal requests survive interruption without duplicate submission.
- Local Codex conversations stream responses, continue across turns, use Toonflow tools, and stop cleanly.
- Missing executable or login produces an actionable setup message.
- No copying or returning Codex authentication material.
- Existing API providers remain usable.

Follow repository restrictions: no added test modules. Run existing affected typechecks/builds and permitted manual validation with isolated local data. Live paid fal generation requires configured credentials and must be reported separately from compilation checks.

References: https://fal.ai/docs/documentation/model-apis/inference/queue and https://learn.chatgpt.com/docs/app-server.
