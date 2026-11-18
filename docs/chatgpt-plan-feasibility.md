# ChatGPT plan provider: isolated feasibility

This is an experiment, not an available or deployed provider.

## Local baseline

- Checkout `sxntax` at `44842565b952292517f8f7d347dbc827cc2b44d2`;
  upstream `v1.29.0` commit `7231fdea693ba14f6952b589eaf16a139dddae79`
  is present locally but is not an ancestor of this checkout. The local
  controller package identifies itself as 1.13.0. Preserve the extensive
  uncommitted station customizations.
- The running `subwave` Compose project includes multiple additional override
  files; do not rebuild it from the root Compose file alone.
- No live station settings, services, or library data were changed by the spike.

## Official API findings

- The operator authorized an individual dynamic SIWC registration with the
  direct plan-usage scope. The official model catalog listed `gpt-6-luna`.
- Against `https://api.openai.com/v1/responses`, with OAuth authorization,
  `store: false` and `stream: true`, GPT-6 Luna completed a text response.
- A synthetic two-turn test then received a namespaced `search_library`
  function call, returned two fixture tracks against its call ID, and received
  a `done` function call whose JSON arguments selected a returned track and
  supplied a nonempty reason. Both turns ended in `response.completed`.
- The experimental `LanguageModelV4` adapter also ran a real `ai@7`
  `generateText` tool loop against GPT-6 Luna: the fixture discovery tool
  executed once and `done` selected a returned fixture ID in two steps. This
  test used the isolated SIWC session, not a Platform API key.
- A forced function selector containing `tool_choice.namespace` returned
  `400 unknown_parameter`. Restricting the visible namespace to the desired
  tool and setting `tool_choice: "required"` worked in this isolated test.
- The preview requires namespaced functions, rejects several sampling and
  output-limit fields, and requires the relevant conversation history in each
  HTTP request. See the [official limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations).

These results establish basic account/model feasibility only. They do not prove
the SUB/WAVE AI SDK integration, refresh after expiry, failure handling, secure
container credential transfer, embeddings preservation, or live operation.
The official DevKit is noncommercial-licensed, so its code must not be copied
into this MIT-licensed controller as if it were MIT licensed.

## Local deployment evidence

The live station subsequently selected `chatgpt-plan:gpt-6-luna`. A controlled
track boundary produced a successful `djAgentPick`: four steps, five discovery
calls, and a final ID present in the returned discovery results. The stream
remained on-air; an audio probe measured MP3 320 kbps, 44.1 kHz stereo and
mean volume −16.9 dB. Speech remained disabled. Embeddings were pinned to the
previously inherited OpenRouter provider without re-indexing.

The controller image was derived from the running local image, with only the
provider overlay added; broadcast and web images were not rebuilt. The
operator-owned controller override is at
`~/.config/subwave-deploy/chatgpt-plan.yml`, and the separate private credential
directory is `~/.config/subwave-chatgpt-plan`. Earlier deployment overrides
remain required too. Protected copies of the prior image metadata and settings
snapshot are under `~/.config/subwave-deploy/`; the preserved pre-existing
working-tree snapshot is under
`/mnt/Tokyo/Lab/.tmp/opencode/subwave-chatgpt-baseline-44842565`.

Focused provider tests cover refresh rotation and restart using deterministic
fixtures. A real token renewal after expiry has not yet been observed.
