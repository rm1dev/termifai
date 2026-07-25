import type { OsKind, SnippetOsTarget } from "@/components/app/types";

export const SNIPPET_OS_TARGET_OPTIONS: { value: SnippetOsTarget; label: string }[] = [
  { value: "all", label: "All OS" },
  { value: "local", label: "Local" },
  { value: "linux", label: "All Linux distros" },
  { value: "ubuntu", label: "Ubuntu" },
  { value: "debian", label: "Debian" },
  { value: "centos", label: "CentOS" },
  { value: "alpine", label: "Alpine" },
  { value: "windows", label: "Windows" },
];

const LINUX_DISTROS: OsKind[] = ["ubuntu", "debian", "centos", "alpine", "other"];

export function matchesOsTarget(
  targets: SnippetOsTarget[] | undefined,
  ctx: { isLocal: boolean; hostOs?: OsKind },
): boolean {
  if (!targets || targets.length === 0 || targets.includes("all")) return true;
  return targets.some((target) => {
    switch (target) {
      case "all":
        return true;
      case "local":
        return ctx.isLocal;
      case "linux":
        return ctx.hostOs != null && LINUX_DISTROS.includes(ctx.hostOs);
      case "windows":
        return ctx.hostOs === "windows";
      default:
        return ctx.hostOs === target;
    }
  });
}
