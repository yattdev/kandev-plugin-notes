// Package main implements the backend half of kandev-plugin-notes.
//
// The note itself still lives entirely in per-user host.storage, a
// browser-reachable capability with no Go-side counterpart (see
// manifest.yaml's capabilities.user_state and ui/bundle.js) — this backend
// never reads or writes note content directly. Its one job is the
// "Enhance with AI" feature: relay the note's current markdown to the
// operator-configured utility agent (capabilities.agent_invoke,
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
	// enhanceErrorCodeAgentUnset: the plugin has no utility agent selected
	// at all (Settings > Plugins > Notes was never used).
	enhanceErrorCodeAgentUnset enhanceErrorCode = "agent_unset"
	// enhanceErrorCodeAgentMissing: the selected agent id no longer exists
	// (deleted after selection).
	enhanceErrorCodeAgentMissing enhanceErrorCode = "agent_missing"
	// enhanceErrorCodeAgentDisabled: the selected agent exists but is
	// disabled — a different fix (Settings > Utility Agents), not a
	// reselection, per the ADR 0048 Enabled asymmetry this plugin cannot
	// change (see README's setup section).
	enhanceErrorCodeAgentDisabled enhanceErrorCode = "agent_disabled"
	// enhanceErrorCodeAgentUnavailable: a FailedPrecondition whose wording
	// matched none of the above — the host may have rephrased its message.
	// Detail still carries that raw wording verbatim so the user sees real
	// information rather than a guessed instruction.
	enhanceErrorCodeAgentUnavailable enhanceErrorCode = "agent_unavailable"
)

// enhanceErrorMessages pairs each code with the one correct remedy. Keep
// this the single source of truth for that mapping — HandleWebhook never
// composes an error message inline, so unset/missing and disabled can never
// be swapped at a call site.
var enhanceErrorMessages = map[enhanceErrorCode]string{
	enhanceErrorCodeAgentUnset:       "No utility agent is configured for this plugin — configure one in Settings > Plugins > Notes.",
	enhanceErrorCodeAgentMissing:     "The utility agent configured for this plugin no longer exists — choose another one in Settings > Plugins > Notes.",
	enhanceErrorCodeAgentDisabled:    "The utility agent configured for this plugin is disabled — enable it (with a model) in Settings > Utility Agents.",
	enhanceErrorCodeAgentUnavailable: "The configured utility agent is unavailable — check Settings > Plugins > Notes.",
}

// classifyUtilityAgentError maps host_utility.go's three distinguishable
// FailedPrecondition wordings ("no utility agent configured for this
// plugin", "configured utility agent %q not found", "configured utility
// agent %q is disabled") to a stable code, kept as its own function (rather
// than inlined at the call site) so the mapping is unit-testable in
// isolation and has exactly one home. Substring matching is coupled to the
// host's current wording — a rephrase degrades to
// enhanceErrorCodeAgentUnavailable rather than misclassifying, since Detail
// (the raw message) is always preserved alongside it.
func classifyUtilityAgentError(message string) enhanceErrorCode {
	switch {
	case strings.Contains(message, "no utility agent configured"):
		return enhanceErrorCodeAgentUnset
	case strings.Contains(message, "not found"):
		return enhanceErrorCodeAgentMissing
	case strings.Contains(message, "is disabled"):
		return enhanceErrorCodeAgentDisabled
	default:
		return enhanceErrorCodeAgentUnavailable
	}
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
			// No utility agent configured, or the configured one was
			// deleted/disabled — a distinguishable, non-fatal condition per
			// ADR 0048, not an internal error. classifyUtilityAgentError
			// turns the host's raw gRPC message into a stable code (C1) so
			// the UI can point at the correct settings page (C2) instead of
			// this one message covering unset/missing/disabled alike.
			rawMessage := status.Convert(err).Message()
			code := classifyUtilityAgentError(rawMessage)
			return jsonResponse(http.StatusPreconditionFailed, enhanceErrorBody{
				Error:  enhanceErrorMessages[code],
				Code:   code,
				Detail: rawMessage,
			})
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
