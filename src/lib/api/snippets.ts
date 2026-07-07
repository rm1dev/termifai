import { invoke } from "@tauri-apps/api/core";
import type { Snippet } from "@/components/app/types";

export function listSnippets(): Promise<Snippet[]> {
  return invoke<Snippet[]>("list_snippets");
}

export function saveSnippet(s: Snippet): Promise<Snippet> {
  return invoke<Snippet>("save_snippet", {
    request: {
      id: s.id,
      kind: s.kind,
      name: s.name,
      body: s.body,
      command: s.command,
      script: s.script,
      variables: s.variables || [],
    },
  });
}

export function removeSnippets(ids: string[]): Promise<void> {
  return invoke<void>("remove_snippets", { ids });
}
