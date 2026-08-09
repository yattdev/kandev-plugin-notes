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

// enhanceErrorBody is the JSON body returned on a handled failure (missing
// utility agent, bad input) — a stable {error} shape the UI can surface
// without parsing prose out of a plain-text body.
type enhanceErrorBody struct {
	Error string `json:"error"`
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
			// No utility agent configured (or the configured one was
			// deleted/disabled) — a distinguishable, non-fatal condition
			// per ADR 0048, not an internal error.
			return jsonErrorResponse(http.StatusPreconditionFailed, "no utility agent is configured for this plugin — configure one in Settings > Plugins > Notes")
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
