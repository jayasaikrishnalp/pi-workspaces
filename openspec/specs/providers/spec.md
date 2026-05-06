# Providers Spec

## Purpose

Pi v0.73 provider catalog and active-model selection. listProviders() reports each of pi's eight built-in providers with status (configured/unconfigured/detected/error) so the frontend Settings screen renders an honest matrix. setActive() validates and atomically updates ~/.pi/agent/settings.json.

## Requirements



### Requirement: List Providers

The system SHALL expose `GET /api/providers` returning a JSON list of LLM providers pi actually knows about, each with its configuration status and available models. The shape:

```ts
{
  providers: Array<{
    id: string;                 // pi's provider id, e.g. "github-copilot", "anthropic", "ollama"
    name: string;               // human-readable label
    kind: "oauth" | "key" | "local";
    status: "configured" | "unconfigured" | "detected" | "error";
    statusReason?: string;      // present on "error" or "unconfigured"; one short sentence
    models: string[];           // model ids pi reports for this provider; empty when unconfigured
  }>;
}
```

The provider id MUST match what pi expects (so `${providerId}/${modelId}` is a valid pi `--model` argument). The list MUST include at minimum `github-copilot` (OAuth), `anthropic`, `openai`, `openrouter`, `google`, `x-ai`, `deepseek` (key), and `ollama` (local) — the providers pi v0.73 supports out of the box.

Status semantics:
- **OAuth providers** (`github-copilot`): check whether `~/.pi/agent/auth.json` contains an entry for the provider. If yes → `configured`; if no → `unconfigured`.
- **Key providers** (`anthropic`, `openai`, `openrouter`, `google`, `x-ai`, `deepseek`): check the env var pi reads for that provider's API key. Configured if the env var is non-empty.
- **Local providers** (`ollama`): probe `http://localhost:11434/api/tags` with a 1-second timeout. `detected` on a 200; `unconfigured` on connection refused; `error` with a `statusReason` on any other failure.

#### Scenario: List returns the eight pi-supported providers

- **GIVEN** the workspace is running and authenticated
- **WHEN** a client sends `GET /api/providers`
- **THEN** the response status is `200`
- **AND** `body.providers` is an array of length ≥ 8 containing entries with `id` ∈ `{"github-copilot", "anthropic", "openai", "openrouter", "google", "x-ai", "deepseek", "ollama"}`

#### Scenario: A configured OAuth provider reports configured + non-empty models

- **GIVEN** `~/.pi/agent/auth.json` contains a `github-copilot` entry
- **WHEN** the client lists providers
- **THEN** the `github-copilot` entry has `status: "configured"`, `kind: "oauth"`, and `models.length > 0`

#### Scenario: An unconfigured key provider reports unconfigured + empty models

- **GIVEN** `ANTHROPIC_API_KEY` is unset in the workspace's env
- **WHEN** the client lists providers
- **THEN** the `anthropic` entry has `status: "unconfigured"`, `kind: "key"`, and `models: []`
- **AND** `statusReason` is a non-empty string mentioning the env var name

#### Scenario: Ollama detection succeeds when the daemon is running

- **GIVEN** `ollama serve` is running on `localhost:11434`
- **WHEN** the client lists providers
- **THEN** the `ollama` entry has `status: "detected"` and `models` lists the entries returned by `/api/tags`

#### Scenario: Ollama not running reports unconfigured (not error)

- **GIVEN** nothing is listening on `localhost:11434`
- **WHEN** the client lists providers
- **THEN** the `ollama` entry has `status: "unconfigured"` and `models: []`

### Requirement: Active Model

The system SHALL expose `GET /api/providers/active` returning `{providerId: string, modelId: string} | {providerId: null, modelId: null}` reflecting pi's current default model selection. The data source MUST be pi's `~/.pi/agent/settings.json` (the same file pi reads itself); the workspace MUST NOT maintain a separate notion of "active model".

#### Scenario: Settings.json with a default model is reported

- **GIVEN** `~/.pi/agent/settings.json` contains `defaultProvider: "github-copilot"` and `defaultModelId: "claude-sonnet-4.6"`
- **WHEN** a client sends `GET /api/providers/active`
- **THEN** the response is `200 {providerId: "github-copilot", modelId: "claude-sonnet-4.6"}`

#### Scenario: No default set returns null fields

- **GIVEN** `~/.pi/agent/settings.json` does not exist OR has no default fields
- **WHEN** the client gets active
- **THEN** the response body is `{providerId: null, modelId: null}`

### Requirement: Set Active Model

The system SHALL expose `PUT /api/providers/active {providerId, modelId}` to update pi's default. The handler MUST:

- Validate that `providerId` matches a provider returned by `GET /api/providers` whose `status` is one of `configured`, `detected` — and reject with `400 PROVIDER_UNCONFIGURED` otherwise.
- Validate that `modelId` is in that provider's `models[]` — reject with `400 UNKNOWN_MODEL` otherwise.
- Atomically update `~/.pi/agent/settings.json` (tmp + rename) preserving any other fields.
- Return `200 {providerId, modelId}` on success.

#### Scenario: Setting a valid provider/model writes settings.json

- **GIVEN** `github-copilot` is configured and exposes `claude-sonnet-4.6`
- **WHEN** a client sends `PUT /api/providers/active {providerId: "github-copilot", modelId: "claude-sonnet-4.6"}`
- **THEN** the response is `200`
- **AND** `~/.pi/agent/settings.json` parses with `defaultProvider: "github-copilot"` and `defaultModelId: "claude-sonnet-4.6"` and any pre-existing fields preserved
- **AND** a subsequent `GET /api/providers/active` returns those values

#### Scenario: Setting an unconfigured provider returns 400

- **GIVEN** `anthropic` is `unconfigured`
- **WHEN** a client sends `PUT /api/providers/active {providerId: "anthropic", modelId: "claude-sonnet-4-20250514"}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"PROVIDER_UNCONFIGURED", ...}}`
- **AND** `~/.pi/agent/settings.json` is unchanged

#### Scenario: Setting an unknown model for a configured provider returns 400

- **GIVEN** `github-copilot` is configured but does not expose `gpt-99`
- **WHEN** the client sends `PUT /api/providers/active {providerId: "github-copilot", modelId: "gpt-99"}`
- **THEN** the response status is `400`
- **AND** the body matches `{"error":{"code":"UNKNOWN_MODEL", ...}}`

### Requirement: Active Model Surfaces In Probe

The system's `GET /api/probe` response SHALL include `pi.activeProvider` and `pi.activeModel` fields reflecting the current default selection (or `null` when no default is set). This lets the frontend render the active model in the probe banner without a second round-trip.

#### Scenario: Probe includes the active model

- **GIVEN** active is `github-copilot/claude-sonnet-4.6`
- **WHEN** an authed client sends `GET /api/probe`
- **THEN** `body.pi.activeProvider === "github-copilot"` and `body.pi.activeModel === "claude-sonnet-4.6"`
