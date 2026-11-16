# Local Codex and fal.ai

This fork uses local Codex sessions for agent work and fal.ai for image/video generation. Local onboarding does not require a Toonflow account. Account/wallet panels, hosted provider promotion, community advertisements and publishing, and marketplace agent tools are removed from the local flow. New installations automatically install only the fal provider; other provider integrations remain available explicitly. Existing user data and provider files are preserved.

## Run locally

Install Bun matching package.json, then from this repository:

```sh
bun install --frozen-lockfile
cd apps/web
bun run build
cd ../server
bun run build
bun run dev
```

Open http://localhost:3000. Build the desired node/tool packages before starting the server, for example `bun run build` in `packages/tools/workspace`, `packages/tools/canvas`, `packages/nodes/textNode`, `packages/nodes/imageNode`, and `packages/nodes/videoNode`. Build other included plugins the same way when needed. Their production artifacts are installed into the configured data directory on server startup. The upstream root-level aggregate build commands are also available, subject to Bun workspace-filter support in the installed runtime.

For live frontend development, run `bun run dev` in `apps/web` in another terminal; Vite proxies API calls to port 3000.

## Codex

1. Install the official Codex CLI and run `codex login` on the machine and OS account running Toonflow's server.
2. Open Settings → Text models → Local Codex. Save and refresh the connection. If `codex` is not on the server's PATH, enter its executable path.
3. Choose a discovered Local Codex model in the conversation's model selector.

Toonflow talks to `codex app-server` over local stdio. It does not read or copy Codex authentication files, or store your login token in provider settings. Browser access to a remote server does not connect to Codex on the browser's machine. A current CLI supporting app-server dynamic tools is required.

Persistent conversations retain a Codex thread across turns. Editing, branching, changing the tool set/model, or interrupted runs cause a fresh thread with the current Toonflow context, preventing stale context from being reused. One turn runs at a time: queue and steering are disabled while local Codex responds; Stop remains available. Text-node and SDK-managed team requests use the existing caller's full context through a stateless Codex adapter. Native command approvals are not silently granted; workspace and canvas actions use Toonflow tools.

## fal.ai

Open Settings → Media models. Edit the installed fal.ai provider, or choose Add provider → fal.ai, and save your own fal.ai API key. Never put the key in prompts or source code.

Supported models:

- `fal-ai/flux/schnell`: text-to-image, 1–4 images, PNG/JPEG, supported preset dimensions and aspect ratios.
- `fal-ai/veo3.1/fast`: text-to-video, 4/6/8 seconds, 720p/1080p, optional generated audio.
- `fal-ai/veo3.1/fast/image-to-video`: the same video settings with exactly one reference image.

The provider submits once to fal's queue, saves the accepted request ID and validated queue URLs, then polls for the output. Resume queries the original request. Ambiguous submission failures are not automatically retried. Stop cancels local waiting; it does not guarantee remote cancellation or a refund. Each wait is limited to 20 minutes; an interrupted persisted task can be checked again.

## Verification limits

No test modules were added, following AGENTS.md. Verification uses existing typechecks/builds and manual checks with isolated local data. Full server/web typechecks require the upstream generated desktop type `.hutch/devkit/api/config/ElectrobunConfig`; a source checkout without that SDK reports a missing-module error even though the standalone production builds succeed. Live fal generation additionally requires a configured fal key and incurs fal usage charges.
