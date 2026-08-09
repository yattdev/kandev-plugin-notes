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
}
