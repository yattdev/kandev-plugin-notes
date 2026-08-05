// Package main tests. notesPlugin has no overridden RPCs, so these tests
// pin the no-op defaults it inherits from UnimplementedPlugin: OnEvent
// acknowledges without side effects and HandleWebhook answers 404 for any
// key, with or without a Host injected.
package main

import (
	"context"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

// fakeHost is a minimal pluginsdk.Host test double. notesPlugin never calls
// any Host method, so every accessor is a bare stub; UnimplementedHostData
// covers the data-API sub-accessors (Tasks/Sessions/...), and the state/
// secret/event methods below cover the rest of the interface.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
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

func TestHandleWebhook_WithHost_Returns404(t *testing.T) {
	p := &notesPlugin{}
	p.SetHost(&fakeHost{})
	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "anything",
		Method:     "POST",
	})
	require.NoError(t, err)
	require.Equal(t, int32(404), resp.Status)
}
