package service

import (
	"reflect"
	"testing"

	"github.com/remote-support/backend/internal/audit"
)

// TestSanitizeEventMetadata asserts that only the per-event-type whitelist of
// non-sensitive keys survives, and that content-bearing fields (clipboard text,
// keystroke contents, arbitrary smuggled keys) are always dropped.
func TestSanitizeEventMetadata(t *testing.T) {
	tests := []struct {
		name      string
		eventType string
		in        map[string]any
		want      map[string]any
	}{
		{
			name:      "file.transfer keeps name/size/direction, drops extras",
			eventType: audit.EventFileTransfer,
			in: map[string]any{
				"name": "notes.txt", "size": 1234, "direction": "to-agent",
				"secret_field": "LEAK", "path": "C:\\secret",
			},
			want: map[string]any{"name": "notes.txt", "size": 1234, "direction": "to-agent"},
		},
		{
			name:      "clipboard.sync keeps direction/length, drops text",
			eventType: audit.EventClipboardSync,
			in: map[string]any{
				"direction": "to-tech", "length": 42, "text": "SECRET",
			},
			want: map[string]any{"direction": "to-tech", "length": 42},
		},
		{
			name:      "input.command_attempt keeps count/kind, drops content",
			eventType: audit.EventInputCommandTry,
			in: map[string]any{
				"count": 3, "kind": "paste", "content": "rm -rf /",
			},
			want: map[string]any{"count": 3, "kind": "paste"},
		},
		{
			name:      "nil metadata yields empty map",
			eventType: audit.EventFileTransfer,
			in:        nil,
			want:      map[string]any{},
		},
		{
			name:      "unknown event type keeps nothing",
			eventType: "not.a.real.event",
			in:        map[string]any{"name": "x", "text": "y"},
			want:      map[string]any{},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizeEventMetadata(tt.eventType, tt.in)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("sanitizeEventMetadata(%q) = %v, want %v", tt.eventType, got, tt.want)
			}
		})
	}
}

// TestAllowedAgentEventTypes asserts the closed data-channel event subset: only
// file.transfer, clipboard.sync, and input.command_attempt are accepted, and
// lifecycle/auth events are rejected.
func TestAllowedAgentEventTypes(t *testing.T) {
	allowed := []string{
		audit.EventFileTransfer,
		audit.EventClipboardSync,
		audit.EventInputCommandTry,
	}
	for _, et := range allowed {
		if !allowedAgentEventTypes[et] {
			t.Errorf("expected %q to be an allowed agent event type", et)
		}
	}

	rejected := []string{
		audit.EventSessionStart,
		audit.EventSessionEnd,
		audit.EventSessionRequest,
		audit.EventSessionApprove,
		audit.EventAuthLogin,
		audit.EventDeviceRegister,
		"",
		"file.transfer.evil",
	}
	for _, et := range rejected {
		if allowedAgentEventTypes[et] {
			t.Errorf("did not expect %q to be an allowed agent event type", et)
		}
	}
}
