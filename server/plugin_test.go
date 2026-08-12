// Package main tests. notesPlugin overrides only HandleWebhook (for the
// "enhance" webhook key); OnEvent still pins the no-op default it inherits
// from UnimplementedPlugin, and HandleWebhook still answers 404 for any
// other key, with or without a Host injected.
package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// fakeHost is a minimal pluginsdk.Host test double. notesPlugin only calls
// InvokeUtilityAgent, so that is the one overridable stub; every other
// accessor is a bare no-op. UnimplementedHostData covers the data-API
// sub-accessors (Tasks/Sessions/...), and the state/secret/event methods
// below cover the rest of the interface.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
	invokeUtilityAgent func(ctx context.Context, prompt string) (string, error)
}

func (fakeHost) GetState(context.Context, string, string, string) (map[string]any, bool, error) {
	return nil, false, nil
}
func (fakeHost) SetState(context.Context, string, string, string, map[string]any) error { return nil }
func (fakeHost) DeleteState(context.Context, string, string, string) error              { return nil }
func (fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}
func (fakeHost) GetConfig(context.Context) (map[string]any, error)    { return map[string]any{}, nil }
func (fakeHost) RevealSecret(context.Context, string) (string, error) { return "", nil }
func (fakeHost) GetSecret(context.Context, string) (string, bool, error) {
	return "", false, nil
}
func (fakeHost) SetSecret(context.Context, string, string) error         { return nil }
func (fakeHost) DeleteSecret(context.Context, string) error              { return nil }
func (fakeHost) EmitEvent(context.Context, string, map[string]any) error { return nil }

func (h fakeHost) InvokeUtilityAgent(ctx context.Context, prompt string) (string, error) {
	if h.invokeUtilityAgent != nil {
		return h.invokeUtilityAgent(ctx, prompt)
	}
	return "", nil
}

var _ pluginsdk.Host = (*fakeHost)(nil)

func TestPlugin_ImplementsPluginInterface(t *testing.T) {
	var _ pluginsdk.Plugin = (*notesPlugin)(nil)
}

func TestOnEvent_NoHost_ReturnsNilWithoutPanicking(t *testing.T) {
	p := &notesPlugin{}
	err := p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"})
	require.NoError(t, err)
}

func TestOnEvent_WithHost_ReturnsNilWithoutTouchingHost(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})
	err := p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"})
	require.NoError(t, err)
}

func TestHandleWebhook_NoHost_Returns404(t *testing.T) {
	p := &notesPlugin{}
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "anything",
		Method:     "POST",
	})
	require.NoError(t, err)
	require.Equal(t, int32(404), resp.Status)
}

func TestHandleWebhook_WithHost_UnknownKey_Returns404(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "anything",
		Method:     "POST",
	})
	require.NoError(t, err)
	require.Equal(t, int32(404), resp.Status)
}

func TestHandleWebhook_Enhance_HappyPath_ReturnsImprovedContent(t *testing.T) {
	p := &notesPlugin{}
	var capturedPrompt string
	p.SetHost(&fakeHost{invokeUtilityAgent: func(_ context.Context, prompt string) (string, error) {
		capturedPrompt = prompt
		return "# Improved\n\nBetter note.", nil
	}})

	body, err := json.Marshal(map[string]string{"content": "# heading\n\nsome typo'd note"})
	require.NoError(t, err)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       body,
	})
	require.NoError(t, err)
	require.Equal(t, int32(200), resp.Status)
	require.Contains(t, capturedPrompt, "some typo'd note")

	var out enhanceResponseBody
	require.NoError(t, json.Unmarshal(resp.Body, &out))
	require.Equal(t, "# Improved\n\nBetter note.", out.Content)
}

func TestHandleWebhook_Enhance_NonPost_ReturnsMethodNotAllowed(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "GET",
	})
	require.NoError(t, err)
	require.Equal(t, int32(405), resp.Status)
}

func TestHandleWebhook_Enhance_EmptyContent_ReturnsBadRequest(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})

	body, err := json.Marshal(map[string]string{"content": ""})
	require.NoError(t, err)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       body,
	})
	require.NoError(t, err)
	require.Equal(t, int32(400), resp.Status)
}

func TestHandleWebhook_Enhance_InvalidJSON_ReturnsBadRequest(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       []byte("not json"),
	})
	require.NoError(t, err)
	require.Equal(t, int32(400), resp.Status)
}

func TestHandleWebhook_Enhance_NoHost_ReturnsServiceUnavailable(t *testing.T) {
	p := &notesPlugin{}

	body, err := json.Marshal(map[string]string{"content": "hello"})
	require.NoError(t, err)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       body,
	})
	require.NoError(t, err)
	require.Equal(t, int32(503), resp.Status)
}

func TestHandleWebhook_Enhance_NoUtilityAgentConfigured_ReturnsPreconditionFailed(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{invokeUtilityAgent: func(context.Context, string) (string, error) {
		return "", status.Error(codes.FailedPrecondition, "no utility agent configured for this plugin")
	}})

	body, err := json.Marshal(map[string]string{"content": "hello"})
	require.NoError(t, err)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       body,
	})
	require.NoError(t, err)
	require.Equal(t, int32(412), resp.Status)

	var out enhanceErrorBody
	require.NoError(t, json.Unmarshal(resp.Body, &out))
	require.NotEmpty(t, out.Error)
	require.Equal(t, enhanceErrorCodeAgentUnset, out.Code)
	require.Equal(t, "no utility agent configured for this plugin", out.Detail)
}

func TestHandleWebhook_Enhance_OtherAgentError_ReturnsBadGateway(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{invokeUtilityAgent: func(context.Context, string) (string, error) {
		return "", status.Error(codes.Internal, "boom")
	}})

	body, err := json.Marshal(map[string]string{"content": "hello"})
	require.NoError(t, err)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "enhance",
		Method:     "POST",
		Body:       body,
	})
	require.NoError(t, err)
	require.Equal(t, int32(502), resp.Status)

	// C3: a real execution failure must never turn into a configuration
	// message — no code/detail leak onto this generic branch.
	var out enhanceErrorBody
	require.NoError(t, json.Unmarshal(resp.Body, &out))
	require.Empty(t, out.Code)
	require.Empty(t, out.Detail)
	require.Equal(t, "AI enhancement failed", out.Error)
}

// TestHandleWebhook_Enhance_ClassifiesEachFailedPreconditionWording is C1/C7:
// each of host_utility.go's classified wordings, plus unclassified ones, maps
// to a code with the raw message preserved verbatim as Detail.
func TestHandleWebhook_Enhance_ClassifiesEachFailedPreconditionWording(t *testing.T) {
	tests := []struct {
		name        string
		hostMessage string
		wantCode    enhanceErrorCode
	}{
		{
			name:        "unset",
			hostMessage: "no utility agent configured for this plugin",
			wantCode:    enhanceErrorCodeAgentUnset,
		},
		{
			name:        "missing",
			hostMessage: `configured utility agent "builtin-enhance-prompt" not found`,
			wantCode:    enhanceErrorCodeAgentMissing,
		},
		{
			name:        "disabled",
			hostMessage: `configured utility agent "builtin-enhance-prompt" is disabled`,
			wantCode:    enhanceErrorCodeAgentDisabled,
		},
		{
			name:        "unrecognized wording degrades to unavailable, not a wrong instruction",
			hostMessage: "utility agent invocation is temporarily throttled",
			wantCode:    enhanceErrorCodeAgentUnavailable,
		},
		{
			// host_utility.go:84 — reachable by following the README's own
			// two-step setup: agent selected AND enabled, but the profile
			// binding left at its shipped default (every builtin utility
			// agent starts with an empty agent_profile_id). Confirmed live
			// against a real host during QA.
			name:        "enabled agent with no bound profile",
			hostMessage: `configured utility agent "builtin-enhance-prompt" has no usable agent profile`,
			wantCode:    enhanceErrorCodeAgentUnconfiguredProfile,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &notesPlugin{}
			p.SetHost(&fakeHost{invokeUtilityAgent: func(context.Context, string) (string, error) {
				return "", status.Error(codes.FailedPrecondition, tt.hostMessage)
			}})

			body, err := json.Marshal(map[string]string{"content": "hello"})
			require.NoError(t, err)

			resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
				WebhookKey: "enhance",
				Method:     "POST",
				Body:       body,
			})
			require.NoError(t, err)
			require.Equal(t, int32(412), resp.Status)

			var out enhanceErrorBody
			require.NoError(t, json.Unmarshal(resp.Body, &out))
			require.Equal(t, tt.wantCode, out.Code)
			require.Equal(t, tt.hostMessage, out.Detail)
			require.Equal(t, enhanceErrorMessage(tt.wantCode, tt.hostMessage), out.Error)

			// An unclassified cause must not prescribe a settings page: the
			// user may have already completed the step it would name. It
			// carries the host's own wording instead.
			if tt.wantCode == enhanceErrorCodeAgentUnavailable {
				require.NotContains(t, out.Error, "Settings >")
				require.Contains(t, out.Error, tt.hostMessage)
			}
		})
	}
}

// TestEnhanceErrorMessage_UnavailableNamesNoPage pins the rule directly: every
// classified code names exactly one remedy page, and agent_unavailable names
// none. Without this, a later edit could quietly reintroduce a wrong-page
// instruction for a cause the plugin cannot identify.
func TestEnhanceErrorMessage_UnavailableNamesNoPage(t *testing.T) {
	for _, code := range []enhanceErrorCode{
		enhanceErrorCodeAgentUnset,
		enhanceErrorCodeAgentMissing,
		enhanceErrorCodeAgentDisabled,
		enhanceErrorCodeAgentUnconfiguredProfile,
	} {
		require.Contains(t, enhanceErrorMessage(code, "raw detail"), "Settings >",
			"classified code %q must name its remedy page", code)
	}

	unavailable := enhanceErrorMessage(enhanceErrorCodeAgentUnavailable, "raw detail")
	require.NotContains(t, unavailable, "Settings >")
	require.Contains(t, unavailable, "raw detail")

	// No detail to pass through: still no invented page.
	require.NotContains(t, enhanceErrorMessage(enhanceErrorCodeAgentUnavailable, ""), "Settings >")
}

// TestClassifyUtilityAgentError_TableDriven exercises classifyUtilityAgentError
// directly, isolated from HandleWebhook and the gRPC status plumbing.
func TestClassifyUtilityAgentError_TableDriven(t *testing.T) {
	tests := []struct {
		message string
		want    enhanceErrorCode
	}{
		{"no utility agent configured for this plugin", enhanceErrorCodeAgentUnset},
		{`configured utility agent "x" not found`, enhanceErrorCodeAgentMissing},
		{`configured utility agent "x" is disabled`, enhanceErrorCodeAgentDisabled},
		{`configured utility agent "x" has no usable agent profile`, enhanceErrorCodeAgentUnconfiguredProfile},
		{"", enhanceErrorCodeAgentUnavailable},
		{"something else entirely", enhanceErrorCodeAgentUnavailable},
	}
	for _, tt := range tests {
		require.Equal(t, tt.want, classifyUtilityAgentError(tt.message), "message: %q", tt.message)
	}
}
