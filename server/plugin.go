package main

import (
	"context"
	"fmt"
	"log"

	"github.com/kandev/kandev/pkg/pluginsdk"
)

// eventCountStateKey is the Host state key this template uses to demonstrate
// the GetState/SetState round trip: every task.created delivery increments a
// persistent counter kept in kandev's state store, scoped to this plugin
// instance. Delete this (and OnEvent) if your plugin doesn't handle events.
const eventCountStateKey = "event_count"

// templatePlugin implements pluginsdk.Plugin (via UnimplementedPlugin). It is
// the one type you customize on the backend side: embed UnimplementedPlugin
// for no-op defaults, then override only the RPCs you need
// (OnEvent / HandleWebhook). Rename it to match your plugin.
type templatePlugin struct {
	pluginsdk.UnimplementedPlugin
}

var _ pluginsdk.Plugin = (*templatePlugin)(nil)

// OnEvent is called for every event type declared in manifest.yaml's
// capabilities.events. Here it logs the delivery and, when a Host has been
// injected, increments a persistent counter through Host state. Returning an
// error asks kandev to retry the delivery; return nil to acknowledge.
func (p *templatePlugin) OnEvent(ctx context.Context, e *pluginsdk.Event) error {
	log.Printf("event delivered: type=%s id=%s", e.EventType, e.EventID)

	host := p.Host()
	if host == nil {
		// Host not injected yet (e.g. the broker dial is still in
		// progress) — nothing more to do for this delivery.
		return nil
	}

	count, err := incrementEventCount(ctx, host)
	if err != nil {
		return fmt.Errorf("kandev-plugin-template: updating event count in Host state: %w", err)
	}
	log.Printf("events counted via Host state: %d", count)
	return nil
}

// incrementEventCount reads the current count from Host state (0 if unset),
// writes back count+1, and returns the new count. Note numbers come back from
// Host state as float64 (the values round-trip through a protobuf Struct on
// the wire), so read them as float64 before converting.
func incrementEventCount(ctx context.Context, host pluginsdk.Host) (int, error) {
	value, found, err := host.GetState(ctx, "instance", "", eventCountStateKey)
	if err != nil {
		return 0, fmt.Errorf("reading %s: %w", eventCountStateKey, err)
	}

	count := 0
	if found {
		if c, ok := value["count"].(float64); ok {
			count = int(c)
		}
	}
	count++

	if err := host.SetState(ctx, "instance", "", eventCountStateKey, map[string]any{"count": count}); err != nil {
		return 0, fmt.Errorf("writing %s: %w", eventCountStateKey, err)
	}
	return count, nil
}

// HandleWebhook implements the webhooks declared in manifest.yaml. kandev
// proxies POST /api/plugins/<id>/webhooks/<key> here; dispatch on
// req.WebhookKey and return the status/body kandev should send back. This one
// answers with a greeting built from the operator-configured settings, to
// show a config read end to end.
func (p *templatePlugin) HandleWebhook(ctx context.Context, req *pluginsdk.WebhookRequest) (*pluginsdk.WebhookResponse, error) {
	log.Printf("webhook received: key=%s method=%s body=%s", req.WebhookKey, req.Method, string(req.Body))
	body := fmt.Sprintf("%s, webhook!", p.greeting(ctx))
	return &pluginsdk.WebhookResponse{Status: 200, Body: []byte(body)}, nil
}

// greeting reads this plugin's operator-editable settings through the Host
// GetConfig RPC — the values saved on the plugin's settings page (the
// manifest's config_schema). kandev restarts the plugin process whenever the
// operator saves, so reading on demand always observes the current values.
// Config is best-effort here: with no Host injected yet, or on an RPC error,
// the greeting falls back to "Hello". A secret field like api_token arrives
// in cleartext through this same call — the only surface where its real value
// is visible.
func (p *templatePlugin) greeting(ctx context.Context) string {
	const fallback = "Hello"
	host := p.Host()
	if host == nil {
		return fallback
	}
	config, err := host.GetConfig(ctx)
	if err != nil {
		log.Printf("reading plugin config: %v", err)
		return fallback
	}
	if greeting, _ := config["greeting"].(string); greeting != "" {
		return greeting
	}
	return fallback
}
