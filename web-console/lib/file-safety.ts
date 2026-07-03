// Pure file-safety heuristics shared by the session file-transfer panel.
// Extracted so the executable-file detection can be unit-tested cleanly.

// Extensions that can execute code on the remote machine and therefore warrant
// an explicit "send anyway" confirmation before transfer.
export const DANGEROUS_EXTENSIONS = [
  ".exe",
  ".msi",
  ".bat",
  ".ps1",
  ".sh",
  ".cmd",
  ".scr",
] as const;

// True when a filename ends with a potentially-executable extension.
export function isDangerous(name: string): boolean {
  const lower = name.toLowerCase();
  return DANGEROUS_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
