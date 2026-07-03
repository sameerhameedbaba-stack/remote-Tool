package auth

import "testing"

// TestGenerateSessionCodeLengthRejection asserts the pure length-range guard:
// lengths outside [6,12] are rejected, and accepted lengths yield a code whose
// normalized (digits-only) form has exactly that many digits.
func TestGenerateSessionCodeLengthRejection(t *testing.T) {
	for _, bad := range []int{0, 1, 5, 13, 20, -1} {
		if _, err := GenerateSessionCode(bad); err == nil {
			t.Errorf("GenerateSessionCode(%d): expected error, got nil", bad)
		}
	}

	for _, good := range []int{6, 7, 9, 12} {
		code, err := GenerateSessionCode(good)
		if err != nil {
			t.Fatalf("GenerateSessionCode(%d): unexpected error %v", good, err)
		}
		if n := len(NormalizeSessionCode(code)); n != good {
			t.Errorf("GenerateSessionCode(%d): normalized length = %d, want %d (code=%q)", good, n, good, code)
		}
	}
}

// TestNormalizeSessionCode asserts formatting characters are stripped so that
// equivalent codes normalize (and therefore hash) identically.
func TestNormalizeSessionCode(t *testing.T) {
	cases := map[string]string{
		"123-456-789": "123456789",
		"123456789":   "123456789",
		" 12 34 ":     "1234",
		"abc123":      "123",
		"":            "",
	}
	for in, want := range cases {
		if got := NormalizeSessionCode(in); got != want {
			t.Errorf("NormalizeSessionCode(%q) = %q, want %q", in, got, want)
		}
	}
}
