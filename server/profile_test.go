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

func TestEnhanceUsesSavedProfile(t *testing.T) {
	for _, defaultProfile := range []string{"platform-default", ""} {
		t.Run("default="+defaultProfile, func(t *testing.T) {
			p := &notesPlugin{}
			p.SetHost(&fakeHost{
				getConfig: func(context.Context) (map[string]any, error) {
					return map[string]any{"agent_profile": "notes-profile", "utility_agent": "legacy-id"}, nil
				},
				invokeWithOptions: func(_ context.Context, prompt string, opts ...pluginsdk.UtilityAgentOptions) (string, error) {
					require.Contains(t, prompt, "hello")
					profile := defaultProfile
					if len(opts) > 0 {
						profile = opts[0].ProfileID
					}
					return profile, nil
				},
			})
			resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{WebhookKey: "enhance", Method: "POST", Body: []byte(`{"content":"hello"}`)})
			require.NoError(t, err)
			require.EqualValues(t, 200, resp.Status)
			var body enhanceResponseBody
			require.NoError(t, json.Unmarshal(resp.Body, &body))
			require.Equal(t, "notes-profile", body.Content)
		})
	}
}

func TestEnhanceRejectsUnavailableSelectionBeforeInvocation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		config map[string]any
		err    error
		want   int32
	}{
		{"missing", nil, nil, 412},
		{"empty", map[string]any{"agent_profile": ""}, nil, 412},
		{"whitespace", map[string]any{"agent_profile": " \t"}, nil, 412},
		{"wrong type", map[string]any{"agent_profile": 42}, nil, 412},
		{"legacy only", map[string]any{"utility_agent": "legacy-id"}, nil, 412},
		{"config read failure", nil, status.Error(codes.Unavailable, "store unavailable"), 502},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := &notesPlugin{}
			called := false
			p.SetHost(&fakeHost{
				getConfig: func(context.Context) (map[string]any, error) { return tc.config, tc.err },
				invokeWithOptions: func(context.Context, string, ...pluginsdk.UtilityAgentOptions) (string, error) {
					called = true
					return "default completion", nil
				},
			})
			resp, err := p.HandleWebhook(context.Background(), &pluginsdk.WebhookRequest{WebhookKey: "enhance", Method: "POST", Body: []byte(`{"content":"hello"}`)})
			require.NoError(t, err)
			require.Equal(t, tc.want, resp.Status)
			require.False(t, called)
			var body enhanceErrorBody
			require.NoError(t, json.Unmarshal(resp.Body, &body))
			if tc.want == 412 {
				require.Equal(t, enhanceErrorCodeAgentUnset, body.Code)
				require.Contains(t, body.Error, "Settings >")
			} else {
				require.Empty(t, body.Code)
			}
		})
	}
}
