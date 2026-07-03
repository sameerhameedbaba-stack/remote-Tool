import { describe, it, expect } from "vitest";
import { isDangerous, DANGEROUS_EXTENSIONS } from "@/lib/file-safety";

describe("isDangerous", () => {
  it("flags executable extensions as dangerous", () => {
    for (const ext of [".exe", ".msi", ".bat", ".ps1", ".sh", ".cmd", ".scr"]) {
      expect(isDangerous(`payload${ext}`)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isDangerous("Setup.EXE")).toBe(true);
    expect(isDangerous("Script.PS1")).toBe(true);
  });

  it("treats safe document/media extensions as safe", () => {
    for (const name of [
      "notes.txt",
      "photo.png",
      "report.pdf",
      "archive.zip",
      "data.json",
      "sheet.csv",
    ]) {
      expect(isDangerous(name)).toBe(false);
    }
  });

  it("does not match an extension in the middle of the name", () => {
    expect(isDangerous("exe-notes.txt")).toBe(false);
    expect(isDangerous("my.exe.txt")).toBe(false);
  });

  it("exports the canonical dangerous-extension list", () => {
    expect(DANGEROUS_EXTENSIONS).toContain(".exe");
    expect(DANGEROUS_EXTENSIONS.length).toBeGreaterThan(0);
  });
});
