// Package main implements the backend half of kandev-plugin-notes.
//
// This plugin has no backend behavior: the note itself lives in per-user
// host.storage, a browser-reachable capability with no Go-side counterpart
// (see manifest.yaml's capabilities.user_state and ui/bundle.js). notesPlugin
// exists only because kandev's installer requires runtime.type: binary — it
// declares no events, no webhooks, and no config, and never overrides
// UnimplementedPlugin's no-op RPCs.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

// notesPlugin implements pluginsdk.Plugin via UnimplementedPlugin's no-op
// defaults. It intentionally overrides nothing.
type notesPlugin struct {
	pluginsdk.UnimplementedPlugin
}

var _ pluginsdk.Plugin = (*notesPlugin)(nil)
