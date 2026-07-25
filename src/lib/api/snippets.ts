import { call } from "./transport";
import type { Snippet, SnippetGroup } from "@/components/app/types";

export function listSnippets(): Promise<{ snippets: Snippet[]; groups: SnippetGroup[] }> {
  return call<{ snippets: Snippet[]; groups: SnippetGroup[] }>("list_snippets");
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
      groupId: s.groupId ?? null,
      keyword: s.kind === "text" ? s.keyword : null,
      osTargets: s.osTargets && s.osTargets.length > 0 ? s.osTargets : [],
    },
  });
}

export function removeSnippets(ids: string[]): Promise<void> {
  return call<void>("remove_snippets", { ids });
}

export function reorderSnippets(ids: string[]): Promise<void> {
  return call<void>("reorder_snippets", { ids });
}

export function saveSnippetGroup(
  name: string,
  parentId: string | null,
  id?: string,
): Promise<SnippetGroup> {
  return call<SnippetGroup>("save_snippet_group", { request: { id: id ?? null, name, parentId } });
}

export function removeSnippetGroup(id: string): Promise<void> {
  return call<void>("remove_snippet_group", { id });
}
