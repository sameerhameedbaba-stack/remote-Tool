// Package migrations embeds the plain-SQL migration files so the backend can
// apply them on boot without shipping the .sql files alongside the binary.
package migrations

import "embed"

// FS holds every migration file (*.up.sql / *.down.sql).
//
//go:embed *.sql
var FS embed.FS
