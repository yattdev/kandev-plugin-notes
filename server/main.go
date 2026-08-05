// Command kandev-plugin-notes is the backend half of this kandev plugin.
// It implements pluginsdk.Plugin (see plugin.go) and is spawned by kandev as
// a gRPC subprocess — there is no HTTP server, no listen address, and no
// secrets to configure: pluginsdk.Serve owns the entire transport.
//
// This plugin's behavior lives entirely in ui/bundle.js, backed by the
// per-user host.storage capability — the Go side exists only because the
// installer requires runtime.type: binary.
package main

import "github.com/kandev/kandev/pkg/pluginsdk"

func main() {
	pluginsdk.Serve(&notesPlugin{})
}
