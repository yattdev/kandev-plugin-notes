// Package main implements the backend half of kandev-plugin-notes.
//
// The note itself still lives entirely in per-user host.storage, a
// browser-reachable capability with no Go-side counterpart (see
// manifest.yaml's capabilities.user_state and ui/bundle.js) — this backend
// never reads or writes note content directly. Its one job is the
// "Enhance with AI" feature: relay the note's current markdown to the
// operator-configured agent profile (capabilities.agent_invoke,
// Host.InvokeUtilityAgent) via a single webhook and return the proofread
// markdown, so the frontend never needs its own LLM credentials. OnEvent
// stays the UnimplementedPlugin no-op — this plugin subscribes to no events.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// enhanceWebhookKey is this plugin's single webhook key (manifest.yaml
// webhooks[].key: "enhance"), reachable at
// POST /api/plugins/kandev-plugin-notes/webhooks/enhance.
const enhanceWebhookKey = "enhance"

// enhancePromptTemplate wraps the note's markdown in a proofreading
// instruction for the one-shot utility-agent completion. The agent is asked
// to return markdown only, matching this plugin's storage format, so the
// response can replace the note verbatim (after the UI's preview/accept
// step) with no reformatting.
const enhancePromptTemplate = `You are a proofreading assistant for a short personal note written in Markdown. Improve grammar, spelling, clarity, and formatting while preserving the author's meaning, tone, and structure. Keep the same Markdown syntax (headings, lists, links, code blocks, emphasis) and do not add commentary, explanations, or a preamble — respond with only the improved Markdown note.

Note:
%s`

// enhanceRequestBody is the JSON body accepted by the enhance webhook.
type enhanceRequestBody struct {
	Content string `json:"content"`
}

// enhanceResponseBody is the JSON body returned by the enhance webhook on
// success: the proofread markdown, under the same field name the UI sent so
// the client can reuse one shape for the request and response.
type enhanceResponseBody struct {
	Content string `json:"content"`
}

// enhanceErrorCode is the enhance webhook's stable, machine-readable 412
// classification (C1) — the UI maps it to a specific settings page (C2)
// instead of guessing from prose. Every other failure branch (400/404/405/
// 502/503) omits Code/Detail and keeps the plain {error} shape it always
// had, via omitempty below.
type enhanceErrorCode string

const (
	// enhanceErrorCodeAgentUnset: the plugin has no agent profile selected
	// at all (Settings > Plugins > Notes was never used).
	enhanceErrorCodeAgentUnset enhanceErrorCode = "agent_unset"
	// enhanceErrorCodeAgentMissing: the selected agent profile no longer exists
	// (deleted after selection).
	enhanceErrorCodeAgentMissing enhanceErrorCode = "agent_missing"
	// enhanceErrorCodeAgentIneligible: the selected profile cannot run a
	// utility completion. Selecting an eligible profile in this plugin's
	// settings is the only remedy.
	enhanceErrorCodeAgentIneligible enhanceErrorCode = "agent_ineligible"
	// enhanceErrorCodeAgentDisabled: the selected agent exists but is
	// disabled — a different fix (Settings > Utility Agents), not a
	// reselection, per the ADR 0048 Enabled asymmetry this plugin cannot
	// change (see README's setup section).
	enhanceErrorCodeAgentDisabled enhanceErrorCode = "agent_disabled"
	// enhanceErrorCodeAgentUnconfiguredProfile: the selected agent exists and
	// is enabled, but has no model / agent profile bound. Distinct from
	// disabled: the remedy is the same page (Settings > Utility Agents) but a
	// different control, and telling this user the agent is "disabled" when
	// they just enabled it is the same dead end as pointing them back at
	// Settings > Plugins > Notes. It earns its own code because it is the
	// state every built-in utility agent ships in, so it is what a user hits
	// immediately after completing the README's two documented steps.
	enhanceErrorCodeAgentUnconfiguredProfile enhanceErrorCode = "agent_unconfigured_profile"
)

// enhanceErrorMessages pairs each code with the one correct remedy. Keep
// this the single source of truth for that mapping — HandleWebhook never
// composes an error message inline, so unset/missing and disabled can never
// be swapped at a call site.
var enhanceErrorMessages = map[enhanceErrorCode]string{
	enhanceErrorCodeAgentUnset:               "No agent profile is configured for this plugin — choose one in Settings > Plugins > Notes.",
	enhanceErrorCodeAgentMissing:             "The agent profile configured for this plugin no longer exists — choose another one in Settings > Plugins > Notes.",
	enhanceErrorCodeAgentIneligible:          "The agent profile configured for this plugin is not eligible for utility execution — choose an eligible profile in Settings > Plugins > Notes.",
	enhanceErrorCodeAgentDisabled:            "The utility agent configured for this plugin is disabled — enable it (with a model) in Settings > Utility Agents.",
	enhanceErrorCodeAgentUnconfiguredProfile: "The utility agent configured for this plugin has no model or agent profile bound — finish setting it up in Settings > Utility Agents.",
}

// enhanceErrorMessage resolves the user-facing message for a recognized
// configuration error. Unknown gRPC errors are execution failures, not setup
// states, and therefore never reach this function.
func enhanceErrorMessage(code enhanceErrorCode) string {
	return enhanceErrorMessages[code]
}

// classifyAgentProfileError maps the host's direct-profile FailedPrecondition
// messages to stable codes. It also retains the two legacy utility-agent
// messages that have distinct Utility Agents remedies for existing configs.
// The direct messages are intentionally exact (apart from the quoted ID): an
// unfamiliar host message must remain an execution failure instead of being
// guessed as a settings problem.
func classifyAgentProfileError(message string) (enhanceErrorCode, bool) {
	switch {
	case message == "no agent profile configured for this plugin":
		return enhanceErrorCodeAgentUnset, true
	case isQuotedConfigurationError(message, "configured agent profile ", " not found"):
		return enhanceErrorCodeAgentMissing, true
	case isQuotedConfigurationError(message, "configured agent profile ", " is not eligible for utility execution"):
		return enhanceErrorCodeAgentIneligible, true
	case isQuotedConfigurationError(message, "configured utility agent ", " is disabled"):
		return enhanceErrorCodeAgentDisabled, true
	case isQuotedConfigurationError(message, "configured utility agent ", " has no usable agent profile"):
		return enhanceErrorCodeAgentUnconfiguredProfile, true
	case message == "no utility agent configured for this plugin":
		// Old hosts used this before the agent_profile config field. The new
		// Notes settings page is still the right place to select a profile.
		return enhanceErrorCodeAgentUnset, true
	case isQuotedConfigurationError(message, "configured utility agent ", " not found"):
		return enhanceErrorCodeAgentMissing, true
	default:
		return "", false
	}
}

// isQuotedConfigurationError recognizes the host's formatted %q ID messages
// without loosening the classifier to unrelated prose that merely shares a
// suffix such as "not found".
func isQuotedConfigurationError(message, prefix, suffix string) bool {
	if !strings.HasPrefix(message, prefix) || !strings.HasSuffix(message, suffix) {
		return false
	}
	id := strings.TrimSuffix(strings.TrimPrefix(message, prefix), suffix)
	return len(id) >= 2 && id[0] == '"' && id[len(id)-1] == '"'
}

// enhanceErrorBody is the JSON body returned on a handled failure (missing
// utility agent, bad input) — a stable {error} shape the UI can surface
// without parsing prose out of a plain-text body. Code/Detail are only ever
// populated on the 412 (utility-agent) branch; every other branch keeps
// the bare {error} shape it always had.
type enhanceErrorBody struct {
	Error  string           `json:"error"`
	Code   enhanceErrorCode `json:"code,omitempty"`
	Detail string           `json:"detail,omitempty"`
}

// notesPlugin implements pluginsdk.Plugin via UnimplementedPlugin's no-op
// defaults for everything except HandleWebhook, which it overrides to
// service the "enhance" key below.
type notesPlugin struct {
	pluginsdk.UnimplementedPlugin
}

var _ pluginsdk.Plugin = (*notesPlugin)(nil)

// HandleWebhook services the "enhance" webhook key: POST {content} ->
// {content: <proofread markdown>}. Any other key returns 404, matching
// UnimplementedPlugin's default for undeclared routes. A missing Host,
// wrong method, or empty content are all guarded before ever calling
// Host.InvokeUtilityAgent.
func (p *notesPlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	if req == nil || req.WebhookKey != enhanceWebhookKey {
		return &pluginsdk.WebhookResponse{Status: http.StatusNotFound}, nil
	}
	if req.Method != http.MethodPost {
		return jsonErrorResponse(http.StatusMethodNotAllowed, "enhance requires POST")
	}

	var body enhanceRequestBody
	if err := json.Unmarshal(req.Body, &body); err != nil {
		return jsonErrorResponse(http.StatusBadRequest, "invalid request body")
	}
	if body.Content == "" {
		return jsonErrorResponse(http.StatusBadRequest, "content must not be empty")
	}

	host := p.Host()
	if host == nil {
		return jsonErrorResponse(http.StatusServiceUnavailable, "plugin host unavailable")
	}

	improved, err := host.InvokeUtilityAgent(ctx, fmt.Sprintf(enhancePromptTemplate, body.Content))
	if err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			// A known configuration failure is non-fatal and lets the UI point
			// at the one setting that fixes it. Other FailedPreconditions can
			// describe a failed invocation, so they remain execution errors.
			rawMessage := status.Convert(err).Message()
			if code, ok := classifyAgentProfileError(rawMessage); ok {
				return jsonResponse(http.StatusPreconditionFailed, enhanceErrorBody{
					Error:  enhanceErrorMessage(code),
					Code:   code,
					Detail: rawMessage,
				})
			}
		}
		return jsonErrorResponse(http.StatusBadGateway, "AI enhancement failed")
	}

	return jsonResponse(http.StatusOK, enhanceResponseBody{Content: improved})
}

// jsonResponse marshals body as the JSON WebhookResponse payload for status.
func jsonResponse(status int32, body any) (*pluginsdk.WebhookResponse, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return jsonErrorResponse(http.StatusInternalServerError, "internal error")
	}
	return &pluginsdk.WebhookResponse{
		Status:  status,
		Headers: map[string]string{"Content-Type": "application/json"},
		Body:    payload,
	}, nil
}

// jsonErrorResponse is jsonResponse for the {error} shape, used on every
// handled failure path above.
func jsonErrorResponse(status int32, message string) (*pluginsdk.WebhookResponse, error) {
	return jsonResponse(status, enhanceErrorBody{Error: message})
}
