import { publish, subscribe, type UnlistenFn } from "./api/transport";

/**
 * Fired whenever a snippet or snippet group is created, edited, removed, or
 * moved. Open terminals listen for this to refresh their in-memory snippet
 * list (palette + keyword map) instead of only picking up changes on next
 * mount — otherwise editing a snippet would have no effect on terminals that
 * were already open.
 */
export const snippetsChangedEvent = "termifai:snippets-changed";

export function notifySnippetsChanged() {
  window.dispatchEvent(new Event(snippetsChangedEvent));
  void publish(snippetsChangedEvent).catch(() => {
    /* Non-Tauri environments (e.g. tests) fall back to the window event above. */
  });
}

export function onSnippetsChanged(handler: () => void): { unlisten: () => void } {
  const onWindowEvent = () => handler();
  window.addEventListener(snippetsChangedEvent, onWindowEvent);

  let tauriUnlisten: UnlistenFn | null = null;
  let cancelled = false;
  void subscribe(snippetsChangedEvent, () => handler())
    .then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      tauriUnlisten = unlisten;
    })
    .catch(() => {});

  return {
    unlisten: () => {
      cancelled = true;
      window.removeEventListener(snippetsChangedEvent, onWindowEvent);
      tauriUnlisten?.();
    },
  };
}
