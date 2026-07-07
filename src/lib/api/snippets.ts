import { call } from "./transport";
import type { Snippet } from "@/components/app/types";

export function listSnippets(): Promise<Snippet[]> {
  return call<Snippet[]>("list_snippets");
}

export function saveSnippet(s: Snippet): Promise<Snippet> {
  return call<Snippet>("save_snippet", {
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
  return call<void>("remove_snippets", { ids });
}
