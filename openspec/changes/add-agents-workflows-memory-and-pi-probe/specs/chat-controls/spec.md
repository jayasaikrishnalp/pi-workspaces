# Delta: chat-controls (NEW)

## ADDED Requirements

### Requirement: Switch Active Model Mid-Session

The system SHALL expose `POST /api/sessions/:sessionKey/model` accepting JSON `{providerId: string, modelId: string}`. The handler MUST validate the pair against `GET /api/providers` (provider must be `configured`/`detected`, model must be in the provider's `models[]`) and forward the change to the running pi child via the RPC `{id, type: "set_model", provider, modelId}` command. On success the response is `200 {providerId, modelId}`. The eventual `model_change` event pi emits flows through the existing chat-event-bus and is delivered to all SSE subscribers — both `/api/chat-events` (live) and `/api/runs/:runId/events` (replay) — without any extra workspace logic, because the Stage 1 mapper already translates `model_change`.

The handler MUST also write the new selection to `~/.pi/agent/settings.json` (same shape as `PUT /api/providers/active`) so the choice survives a workspace restart.

#### Scenario: Valid switch returns 200 and emits model_change

- **GIVEN** a session `s1` is connected to pi and provider `github-copilot/claude-sonnet-4.6` is current
- **AND** provider `anthropic` is `configured` with `claude-sonnet-4-20250514` in its model list
- **WHEN** a client sends `POST /api/sessions/s1/model {providerId:"anthropic", modelId:"claude-sonnet-4-20250514"}`
- **THEN** the response status is `200` with body `{providerId:"anthropic", modelId:"claude-sonnet-4-20250514"}`
- **AND** within ~1s a `model_change` event arrives on the chat-event-bus carrying `data.modelId === "claude-sonnet-4-20250514"`
- **AND** `~/.pi/agent/settings.json` now has `defaultProvider: "anthropic"` and `defaultModelId: "claude-sonnet-4-20250514"`

#### Scenario: Unconfigured provider is rejected before pi is touched

- **GIVEN** provider `openrouter` is `unconfigured`
- **WHEN** a client sends `POST /api/sessions/s1/model {providerId:"openrouter", modelId:"x/y"}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"PROVIDER_UNCONFIGURED", ...}}`
- **AND** no command is written to pi
- **AND** `settings.json` is unchanged

#### Scenario: Unknown session is rejected with 404

- **WHEN** a client sends `POST /api/sessions/no-such/model {providerId:"github-copilot", modelId:"claude-sonnet-4.6"}`
- **THEN** the response status is `404`
- **AND** the body matches `{"error":{"code":"UNKNOWN_SESSION", ...}}`

### Requirement: Cycle Active Model Forward/Backward

The system SHALL expose `POST /api/sessions/:sessionKey/model/cycle?direction=forward|backward`. The handler maps to pi's RPC `{type: "cycle_model"}`. The provider list pi cycles through is the union of configured/detected providers' models, in pi's own order. The response is `200 {providerId, modelId}` reflecting pi's confirmation in the subsequent `model_change` event (handler awaits the event for up to 1500ms, else returns `200 {pending: true}`).

#### Scenario: Cycle forward switches to the next model

- **GIVEN** the active model is `github-copilot/claude-sonnet-4.6` and the next configured model is `anthropic/claude-opus-4.6`
- **WHEN** a client sends `POST /api/sessions/s1/model/cycle?direction=forward`
- **THEN** the response is `200`
- **AND** a `model_change` event arrives with `modelId:"claude-opus-4.6"`

### Requirement: Forward Pi UI Requests To Subscribers

The system SHALL forward pi's `extension_ui_request` JSON-line outputs to the chat-event-bus as a normalized `pi.ui-request` event so SSE subscribers can render the prompt. The forwarded payload MUST preserve `id`, `method`, `title`, and any method-specific fields (`options`/`message`/`prefill`/etc) verbatim. The Stage 1 mapper currently drops unknown event types; this change widens the mapper switch to recognize `extension_ui_request` and emit a `pi.ui-request` normalized event with `runId`, `sessionKey`, and the original payload nested under `request`.

#### Scenario: Pi confirm prompt becomes a pi.ui-request event

- **GIVEN** pi is mid-run and emits `{"type":"extension_ui_request","id":"r-7","method":"confirm","title":"Run rm -rf /tmp/x?","message":"This is destructive."}`
- **WHEN** the bridge processes the line
- **THEN** the chat-event-bus emits a normalized event with `event:"pi.ui-request"` and `data.request === {id:"r-7", method:"confirm", title:"…", message:"…"}`
- **AND** the run-store persists this event with the next monotonic `seq`

### Requirement: Respond To Pi UI Requests

The system SHALL expose `POST /api/runs/:runId/ui-response` accepting JSON matching pi's `RpcExtensionUIResponse` discriminated union (`{id, value}` for select/editor, `{id, confirmed}` for confirm, `{id, cancelled: true}` for cancel). The handler MUST validate that a matching pi.ui-request is in flight for the run (i.e., the request's `id` was observed since the last terminal event) and forward the response to pi via stdin as one JSON line. Returns `200 {ok: true}`.

#### Scenario: Approving a confirm forwards the response to pi

- **GIVEN** a run `r1` in flight whose latest `pi.ui-request` had `id:"r-7"` and `method:"confirm"`
- **WHEN** a client sends `POST /api/runs/r1/ui-response {id:"r-7", confirmed: true}`
- **THEN** the response is `200`
- **AND** pi's stdin receives one JSON line equal to `{"type":"extension_ui_response","id":"r-7","confirmed":true}`

#### Scenario: A response for an id we never saw is rejected with 400

- **WHEN** a client sends `POST /api/runs/r1/ui-response {id:"never-seen", confirmed: true}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"UNKNOWN_UI_REQUEST", ...}}`

#### Scenario: A response after the run terminated is rejected with 409

- **GIVEN** a run that has emitted `run.completed`
- **WHEN** a client sends `POST /api/runs/<id>/ui-response {id:"r-7", confirmed:true}`
- **THEN** the response status is `409`
- **AND** the body matches `{"error":{"code":"RUN_FINISHED", ...}}`
