import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  findPatterns,
  getFindPattern,
  type FindPart,
  type FindPatternId,
} from "@/lib/terminal-find";
import { cn } from "@/lib/utils";

/** برای پارک کرسر بعد از pill — از کوئری حذف می‌شه */
const ZWSP = "\u200B";

const PATTERN_IDS = new Set(findPatterns.map((p) => p.id));

function isPatternId(value: string): value is FindPatternId {
  return PATTERN_IDS.has(value as FindPatternId);
}

function partsEqual(a: FindPart[], b: FindPart[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((part, i) => {
    const other = b[i];
    if (part.kind !== other.kind) return false;
    if (part.kind === "text" && other.kind === "text") {
      return part.value === other.value;
    }
    if (part.kind === "token" && other.kind === "token") {
      return part.id === other.id;
    }
    return false;
  });
}

/** DOM توکن‌فیلد → FindPart[] (ZWSP و متن خالی دور ریخته می‌شه) */
export function serializeFindTokenField(root: HTMLElement): FindPart[] {
  const parts: FindPart[] = [];
  const pushText = (raw: string) => {
    const value = raw.replaceAll(ZWSP, "");
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last?.kind === "text") last.value += value;
    else parts.push({ kind: "text", value });
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tokenId = el.dataset.findToken;
    if (tokenId && isPatternId(tokenId)) {
      parts.push({ kind: "token", id: tokenId });
      return;
    }
    // br / div های ناخواسته رو نادیده بگیر یا خط جدید نساز
    if (el.tagName === "BR") return;
    for (const child of Array.from(el.childNodes)) walk(child);
  };

  for (const child of Array.from(root.childNodes)) walk(child);
  return parts;
}

function createTokenElement(
  id: FindPatternId,
  onRemove: (el: HTMLElement) => void
): HTMLSpanElement {
  const def = getFindPattern(id);
  const span = document.createElement("span");
  span.contentEditable = "false";
  span.dataset.findToken = id;
  span.setAttribute("role", "button");
  span.tabIndex = -1;
  span.title = `${def.label} — click to remove`;
  // هم‌تراز با text-sm خط ادیتور — بدون translate که pill رو بالا می‌ندازه
  span.className = cn(
    "mx-1 inline-flex h-[1.25rem] select-none items-center rounded-full px-2 align-middle text-xs font-semibold leading-none",
    def.pillClass
  );
  span.style.verticalAlign = "middle";
  span.textContent = def.pill;
  span.addEventListener("mousedown", (e) => {
    // نذار فوکوس از ادیتور بپره قبل از remove
    e.preventDefault();
  });
  span.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onRemove(span);
  });
  return span;
}

function placeCaretAfter(node: Node) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

function selectAllContents(root: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  sel.removeAllRanges();
  sel.addRange(range);
}

export type FindTokenFieldHandle = {
  focus: () => void;
  insertToken: (id: FindPatternId) => void;
  selectAll: () => void;
};

type Props = {
  parts: FindPart[];
  onPartsChange: (parts: FindPart[]) => void;
  focusKey?: number;
  placeholder?: string;
  onSubmit: (shiftKey: boolean) => void;
  onEscape: () => void;
  className?: string;
};

/**
 * فیلد توکنی تک‌خطی — الگوی TokenField / contentEditable
 * (مثل React Aria TokenField و فیلد To: مک): کرسر بین متن و pillها طبیعی حرکت می‌کنه.
 */
export const FindTokenField = forwardRef<FindTokenFieldHandle, Props>(
  function FindTokenField(
    {
      parts,
      onPartsChange,
      focusKey = 0,
      placeholder = "Find…",
      onSubmit,
      onEscape,
      className,
    },
    ref
  ) {
    const editorRef = useRef<HTMLDivElement>(null);
    // وقتی خودمون DOM رو عوض کردیم، از sync معکوس parts→DOM رد شو
    const skipPropSyncRef = useRef(false);

    const syncEmptyAttr = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      const empty = serializeFindTokenField(el).length === 0;
      el.dataset.empty = empty ? "true" : "false";
    }, []);

    const emitFromDom = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      skipPropSyncRef.current = true;
      onPartsChange(serializeFindTokenField(el));
      syncEmptyAttr();
    }, [onPartsChange, syncEmptyAttr]);

    const removeTokenEl = useCallback(
      (tokenEl: HTMLElement) => {
        const el = editorRef.current;
        if (!el) return;
        const zw = tokenEl.nextSibling;
        const marker = document.createTextNode("");
        tokenEl.parentNode?.insertBefore(marker, tokenEl);
        tokenEl.remove();
        // ZWSP بعدی رو هم جمع کن
        if (zw?.nodeType === Node.TEXT_NODE && zw.textContent === ZWSP) {
          zw.remove();
        }
        el.focus();
        placeCaretAfter(marker);
        emitFromDom();
      },
      [emitFromDom]
    );

    const renderPartsToDom = useCallback(
      (next: FindPart[]) => {
        const el = editorRef.current;
        if (!el) return;
        el.replaceChildren();
        for (const part of next) {
          if (part.kind === "text") {
            el.appendChild(document.createTextNode(part.value));
          } else {
            el.appendChild(createTokenElement(part.id, removeTokenEl));
            el.appendChild(document.createTextNode(ZWSP));
          }
        }
        syncEmptyAttr();
      },
      [removeTokenEl, syncEmptyAttr]
    );

    // sync از بیرون (مثلاً seed با selection)
    useEffect(() => {
      if (skipPropSyncRef.current) {
        skipPropSyncRef.current = false;
        return;
      }
      const el = editorRef.current;
      if (!el) return;
      if (partsEqual(serializeFindTokenField(el), parts)) {
        syncEmptyAttr();
        return;
      }
      renderPartsToDom(parts);
    }, [parts, renderPartsToDom, syncEmptyAttr]);

    useEffect(() => {
      const el = editorRef.current;
      if (!el) return;
      const id = requestAnimationFrame(() => {
        el.focus();
        if (serializeFindTokenField(el).length > 0) selectAllContents(el);
        else placeCaretAtEnd(el);
      });
      return () => cancelAnimationFrame(id);
    }, [focusKey]);

    const insertToken = useCallback(
      (id: FindPatternId) => {
        const el = editorRef.current;
        // از روی DOM (اگه هست) بساز تا متن تایپ‌شده از دست نره
        const base = el ? serializeFindTokenField(el) : parts;
        const next: FindPart[] = [...base, { kind: "token", id }];

        // فوری رندر کن — Selection بعد از Dropdown قابل‌اعتماد نیست
        renderPartsToDom(next);
        skipPropSyncRef.current = true;
        onPartsChange(next);

      },
      [onPartsChange, parts, renderPartsToDom]
    );

    const focusEditor = useCallback(() => {
      const el = editorRef.current;
      if (!el) return;
      el.focus();
      placeCaretAtEnd(el);
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        focus: focusEditor,
        insertToken,
        selectAll: () => {
          const el = editorRef.current;
          if (el) selectAllContents(el);
        },
      }),
      [focusEditor, insertToken]
    );

    return (
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Find"
        aria-multiline="false"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        data-empty="true"
        spellCheck={false}
        className={cn(
          "min-w-0 flex-1 overflow-x-auto whitespace-pre py-1 text-sm leading-5 text-foreground outline-none",
          "[&[data-empty=true]]:before:pointer-events-none [&[data-empty=true]]:before:text-muted-foreground",
          "[&[data-empty=true]]:before:content-[attr(data-placeholder)]",
          // pillهای داخل contentEditable با vertical-align:middle وسط خط می‌شینن
          "[&_[data-find-token]]:align-middle",
          className
        )}
        onInput={() => {
          const el = editorRef.current;
          if (!el) return;
          // WebKit گاهی <br>/div می‌ندازه؛ تک‌خطی نگه می‌داریم
          for (const br of el.querySelectorAll("br")) br.remove();
          emitFromDom();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onEscape();
            return;
          }
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            onSubmit(e.shiftKey);
          }
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " ");
          if (!text) return;
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const node = document.createTextNode(text);
          range.insertNode(node);
          placeCaretAfter(node);
          emitFromDom();
        }}
        onClick={() => editorRef.current?.focus()}
      />
    );
  }
);
