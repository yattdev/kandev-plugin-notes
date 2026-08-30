package plugins

// This file is applied to Kandev's internal/plugins package through a Go
// overlay by scripts/test-host-upgrade-state.sh. Keeping the test in this
// repository lets every Notes release gate the exact host lifecycle it
// depends on without modifying the sibling Kandev checkout.

import (
	"context"
	"testing"
)

const notesPersistencePluginID = "kandev-plugin-notes"

type notesUserStateCleanupSpy struct {
	pluginIDs []string
}

func (s *notesUserStateCleanupSpy) DeleteAllForPlugin(_ context.Context, pluginID string) error {
	s.pluginIDs = append(s.pluginIDs, pluginID)
	return nil
}

func TestNotesPluginVersionReplacementPreservesUserState(t *testing.T) {
	svc, _, _ := newTestService(t)
	cleanup := &notesUserStateCleanupSpy{}
	svc.setUserStateCleanupStore(cleanup)

	installTestPlugin(t, svc, notesPersistencePluginID)

	for _, version := range []string{"1.1.0", "0.9.0"} {
		rec, err := svc.Install(
			t.Context(),
			testPackage(t, notesPersistencePluginID, version, false),
		)
		if err != nil {
			t.Fatalf("Install(%s) over existing Notes version: %v", version, err)
		}
		if rec.Version != version {
			t.Fatalf("Install(%s) recorded version %q", version, rec.Version)
		}
		if len(cleanup.pluginIDs) != 0 {
			t.Fatalf(
				"Install(%s) purged plugin user state for %v; version replacement must never call DeleteAllForPlugin",
				version,
				cleanup.pluginIDs,
			)
		}
	}
}
