/**
 * Mirrors src-tauri/src/sftp.rs path-segment guards used by SFTP rename/mkdir.
 * Run: node scripts/validate-path-segment.mjs
 */

function validatePathSegment(name) {
  const trimmed = name.trim();
  if (!trimmed) return "Name cannot be empty";
  if (trimmed === "." || trimmed === "..") return "Invalid name";
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    return "Name cannot contain path separators";
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return "Name must be a single path segment";
  }
  if (trimmed.includes("/") || trimmed.split(/[/\\]/).filter(Boolean).length !== 1) {
    return "Name must be a single path segment";
  }
  return null;
}

function sameDirRename(fromPath, toPath) {
  const fromParent = fromPath.replace(/[/\\][^/\\]+$/, "") || "/";
  const toParent = toPath.replace(/[/\\][^/\\]+$/, "") || "/";
  if (fromParent !== toParent) return "Rename must stay in the same directory";
  const name = toPath.split(/[/\\]/).pop() || "";
  return validatePathSegment(name);
}

function rejectParentDir(path) {
  const parts = path.split(/[/\\]/);
  if (parts.includes("..")) return "Path cannot contain '..'";
  return null;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(validatePathSegment("notes.txt") === null, "accept plain name");
assert(validatePathSegment("../secrets.txt") !== null, "reject ../");
assert(validatePathSegment("foo/bar") !== null, "reject nested");
assert(validatePathSegment("/etc/passwd") !== null, "reject absolute");
assert(validatePathSegment("..") !== null, "reject ..");
assert(sameDirRename("/home/u/a.txt", "/home/u/b.txt") === null, "same-dir ok");
assert(sameDirRename("/home/u/a.txt", "/etc/passwd") !== null, "cross-dir blocked");
assert(sameDirRename("/home/u/a.txt", "/home/u/../b.txt") !== null, "dotdot parent blocked");
assert(rejectParentDir("/home/u/new") === null, "mkdir ok");
assert(rejectParentDir("/home/u/../evil") !== null, "mkdir .. blocked");

console.log("validate-path-segment: ok");
