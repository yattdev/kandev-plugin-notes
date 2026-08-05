// Package main tests. Exercises templatePlugin's Plugin methods (OnEvent,
// InvokeTool, HandleWebhook) via direct calls against a fakeHost — no
// go-plugin subprocess needed. This is the fast, hermetic way to test a
// kandev plugin's backend half; copy the fakeHost pattern for your own tests.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/kandev/kandev/pkg/pluginsdk"
	"github.com/stretchr/testify/require"
)

// fakeHost is an in-memory pluginsdk.Host test double that actually stores
// state (unlike a call-recording spy), so tests can assert the
// get-then-increment-then-set round trip. SetState round-trips values through
// JSON, mirroring the real Host's protobuf Struct conversion: numbers always
// come back as float64, never the original Go numeric type — a fake that just
// stored the raw Go value would hide bugs like reading a JSON number as int.
// UnimplementedHostData satisfies the Host data API accessors this plugin
// doesn't use.
type fakeHost struct {
	pluginsdk.UnimplementedHostData
	mu     sync.Mutex
	state  map[string]map[string]any
	config map[string]any
}

func newFakeHost() *fakeHost {
	return &fakeHost{state: make(map[string]map[string]any)}
}

func stateKey(scope, scopeID, key string) string {
	return scope + "/" + scopeID + "/" + key
}

func (h *fakeHost) GetState(_ context.Context, scope, scopeID, key string) (map[string]any, bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	v, ok := h.state[stateKey(scope, scopeID, key)]
	return v, ok, nil
}

func (h *fakeHost) SetState(_ context.Context, scope, scopeID, key string, value map[string]any) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.state[stateKey(scope, scopeID, key)] = jsonRoundTrip(value)
	return nil
}

// jsonRoundTrip marshals v to JSON and back into map[string]any, so numeric
// values normalize to float64 exactly like structpb.Struct.AsMap() does on
// the real wire.
func jsonRoundTrip(v map[string]any) map[string]any {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		panic(err)
	}
	return out
}

func (h *fakeHost) DeleteState(context.Context, string, string, string) error { return nil }

func (h *fakeHost) ListState(context.Context, string, string) ([]pluginsdk.StateEntry, error) {
	return nil, nil
}

// GetConfig returns the operator-saved settings the real Host reads from
// kandev's plugin config store.
func (h *fakeHost) GetConfig(context.Context) (map[string]any, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.config == nil {
		return map[string]any{}, nil
	}
	return h.config, nil
}

func (h *fakeHost) RevealSecret(context.Context, string) (string, error) { return "", nil }

func (h *fakeHost) GetSecret(context.Context, string) (string, bool, error) {
	return "", false, nil
}
func (h *fakeHost) SetSecret(context.Context, string, string) error { return nil }
func (h *fakeHost) DeleteSecret(context.Context, string) error      { return nil }

func (h *fakeHost) EmitEvent(context.Context, string, map[string]any) error { return nil }

var _ pluginsdk.Host = (*fakeHost)(nil)

func TestOnEvent_NoHost_ReturnsNilWithoutPanicking(t *testing.T) {
	p := &templatePlugin{}
	err := p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"})
	require.NoError(t, err)
}

func TestOnEvent_IncrementsEventCountViaHostState(t *testing.T) {
	p := &templatePlugin{}
	host := newFakeHost()
	p.SetHost(host)

	require.NoError(t, p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"}))
	value, found, err := host.GetState(context.Background(), "instance", "", eventCountStateKey)
	require.NoError(t, err)
	require.True(t, found)
	require.InEpsilon(t, float64(1), value["count"], 0)

	require.NoError(t, p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e2", EventType: "task.created"}))
	value, found, err = host.GetState(context.Background(), "instance", "", eventCountStateKey)
	require.NoError(t, err)
	require.True(t, found)
	require.InEpsilon(t, float64(2), value["count"], 0)
}

// errHost fails every SetState call, to prove OnEvent surfaces a Host write
// failure rather than silently swallowing it.
type errHost struct {
	fakeHost
}

func (h *errHost) SetState(context.Context, string, string, string, map[string]any) error {
	return errors.New("boom")
}

func TestOnEvent_PropagatesHostSetStateError(t *testing.T) {
	p := &templatePlugin{}
	p.SetHost(&errHost{fakeHost: *newFakeHost()})

	err := p.OnEvent(context.Background(), &pluginsdk.Event{EventID: "e1", EventType: "task.created"})
	require.Error(t, err)
}

func TestHandleWebhook_DefaultGreetingWithoutHost(t *testing.T) {
	p := &templatePlugin{}

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "ping",
		Method:     "POST",
		Body:       []byte(`{"ping":true}`),
	})
	require.NoError(t, err)
	require.Equal(t, int32(200), resp.Status)
	require.Equal(t, "Hello, webhook!", string(resp.Body))
}

func TestHandleWebhook_UsesOperatorConfig(t *testing.T) {
	p := &templatePlugin{}
	host := newFakeHost()
	host.config = map[string]any{"greeting": "Howdy", "api_token": "secret"}
	p.SetHost(host)

	resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{
		WebhookKey: "ping",
		Method:     "POST",
	})
	require.NoError(t, err)
	require.Equal(t, int32(200), resp.Status)
	require.Equal(t, "Howdy, webhook!", string(resp.Body))
}
