# ChatGPT plan provider

`chatgpt-plan` is separate from `openai`: the former uses an authorized
ChatGPT account via the public Responses API; the latter uses a separately
billed Platform API key. No Platform key is used by the plan provider.

Before enabling it, check [ChatGPT usage settings](https://chatgpt.com/settings/usage)
and disable any option to use credits after the plan limit if you do not want
extra charges. Plan eligibility and limits are controlled by OpenAI.
ChatGPT plan usage does not cover embeddings. If embeddings previously followed
the chat provider, SUB/WAVE pins that provider before switching; those
embeddings may still incur their own charges. No re-index is needed.

## Connect on the browser machine

From the checkout's `controller/` directory:

```sh
mkdir -p "$HOME/.config/subwave-chatgpt-plan"
chmod 700 "$HOME/.config/subwave-chatgpt-plan"
node_modules/.bin/tsx scripts/chatgpt-plan-auth.ts connect "$HOME/.config/subwave-chatgpt-plan"
```

Open the displayed official OpenAI URL on the same machine and authorize plan
usage. Never paste a callback URL or tokens into chat. `connect` reuses a
previous registration; `disconnect` removes tokens and attempts remote
revocation. Check connection with `status`, and use `models` to list the
account's current available models. Both take the same directory argument.

The directory must be private (owner-only, mode 0700); its files are mode 0600.
It contains OAuth credentials. Keep it outside the repository, station state,
backups and browser-accessible directories. On a remote controller, follow the
[official secure-transfer procedure](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
and use a separate stable host ID for the remote host. Do not run two active
copies of a transferred session; refresh tokens rotate.

## Container setup and selection

The controller needs the private directory mounted read/write at an absolute
path, owned by its runtime UID, with `SUBWAVE_CHATGPT_PLAN_DIR` set to that
container path. It must remain available across rebuilds. For example, in an
operator-owned Compose override, substituting the real absolute host path:

```yaml
services:
  controller:
    environment:
      SUBWAVE_CHATGPT_PLAN_DIR: /run/subwave-chatgpt-plan
    volumes:
      - /absolute/private/host/path:/run/subwave-chatgpt-plan
```

On SELinux systems, configure an appropriate private label for the bind mount.
Do not weaken permissions or publish this directory through a web server.
Rebuild and recreate only the controller with the installation's **complete**
Compose configuration; preserve its existing overrides and image rollback ID.

After the controller is ready, run these commands inside the controller:

```sh
docker exec sub-wave-controller node_modules/.bin/tsx scripts/chatgpt-plan-auth.ts status /run/subwave-chatgpt-plan
docker exec sub-wave-controller node_modules/.bin/tsx scripts/chatgpt-plan-auth.ts models /run/subwave-chatgpt-plan
docker exec sub-wave-controller node_modules/.bin/tsx scripts/chatgpt-plan-auth.ts probe /run/subwave-chatgpt-plan MODEL_ID
docker exec sub-wave-controller node_modules/.bin/tsx scripts/chatgpt-plan-auth.ts activate /run/subwave-chatgpt-plan MODEL_ID
```

Replace `MODEL_ID` with an actual catalog entry. The probe is a non-broadcast
model call; `activate` patches only the primary LLM provider and model via the
local authenticated controller settings API. It does not switch TTS, scheduling,
the mixer, or the music library. The admin Settings page can also select the
provider and lists models when the session is connected.

## Failure and rollback

The provider waits for `response.completed` before it exposes text or tools.
Quota and authorization failures stop same-leg retries; quota failures are
temporarily held off to avoid hammering the account. Automatic fallback from a
plan primary is restricted to an explicitly configured local Ollama model:
it never silently switches to a metered API. Existing non-LLM music recovery
remains in place.

`status` returns `connected`, `disconnected`, `reauth_required`, or
`unavailable`. A reauthentication needs `connect` on the browser machine;
never run that command concurrently with active controller refreshes against
the same session. Disconnect using the CLI, and if remote revocation could not
be confirmed, remove the app from ChatGPT settings.

To disable the provider, choose the previous provider and model in admin
Settings. Restore the prior controller image and Compose configuration if
rolling back code. Keep the pinned embedding provider and index unchanged; do
not delete or rebuild the library. For this installation the before-state
provider and image are recorded in the protected deployment snapshot.

### This installation

The active controller override is `~/.config/subwave-deploy/chatgpt-plan.yml`.
Its credential-free image build context is
`~/.config/subwave-deploy/chatgpt-plan-build`; it layers the provider onto the
pre-deployment controller image, preserving customizations in that image. The
prior image and original Compose file list are in
`~/.config/subwave-deploy/live-images.json`. `live-settings.json` in the same
private directory is a sensitive snapshot, not a file to publish or restore
wholesale over newer station changes.

The web image was intentionally not rebuilt: this checkout has unrelated
pre-existing web lint failures and undeployed web edits. The newer Settings UI
connection status and model picker are in source, but are not in the running
web image. Use the controller CLI above for connection status, discovery and
activation until a separately verified web deployment is ready.

The previous primary was OpenRouter model `deepseek/deepseek-v4-flash-0731`.
Switching back to it may incur OpenRouter charges. To roll back code, first
select that provider and model in admin Settings, then recreate **only** the
controller with the original Compose file list:

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
info = json.loads((Path.home() / '.config/subwave-deploy/live-images.json').read_text())
files = info['sub-wave-controller']['compose_files'].split(',')
cmd = ['docker', 'compose']
for file in files:
    cmd.extend(['-f', file])
cmd.extend(['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'controller'])
subprocess.run(cmd, check=True)
PY
```

This leaves the pinned OpenRouter embedding configuration and existing library
index in place. The original Compose list includes operator-managed override
files under `/mnt/Tokyo/Lab/.tmp/opencode`; preserve those files.
