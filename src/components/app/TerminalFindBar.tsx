import { useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Regex,
  Search,
  Settings2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  FindTokenField,
  type FindTokenFieldHandle,
} from "@/components/app/FindTokenField";
import {
  findPatterns,
  getFindPattern,
  type FindMatchMode,
  type FindOptions,
  type FindPart,
  type FindPatternId,
} from "@/lib/terminal-find";
import { cn } from "@/lib/utils";

interface Props {
  options: FindOptions;
  parts: FindPart[];
  resultIndex: number;
  resultCount: number;
  /** هر بار زیاد بشه، ورودی دوباره فوکوس می‌گیره (مثلاً Cmd+F دوباره) */
  focusKey?: number;
  onOptionsChange: (next: FindOptions) => void;
  onPartsChange: (parts: FindPart[]) => void;
  onFindNext: () => void;
  onFindPrevious: () => void;
  onClose: () => void;
}

const breakPatterns = findPatterns.filter((p) => p.section === "breaks");
const classPatterns = findPatterns.filter((p) => p.section === "classes");
const dataPatterns = findPatterns.filter((p) => p.section === "data");

function PatternMenuItem({
  id,
  onSelect,
}: {
  id: FindPatternId;
  onSelect: (id: FindPatternId) => void;
}) {
  const def = getFindPattern(id);
  return (
    <DropdownMenuItem onSelect={() => onSelect(id)} className="gap-2">
      <span
        className={cn(
          "inline-flex min-w-10 items-center justify-center rounded-full px-2 py-0.5 text-[10px] font-semibold",
          def.pillClass
        )}
      >
        {def.icon ?? def.pill}
      </span>
      <span className="flex-1">{def.label}</span>
    </DropdownMenuItem>
  );
}

export function TerminalFindBar({
  options,
  parts,
  resultIndex,
  resultCount,
  focusKey = 0,
  onOptionsChange,
  onPartsChange,
  onFindNext,
  onFindPrevious,
  onClose,
}: Props) {
  const fieldRef = useRef<FindTokenFieldHandle>(null);
  const [patternOpen, setPatternOpen] = useState(false);

  const insertToken = (id: FindPatternId) => {
    // onSelect منو فوکوس/Selection رو خراب می‌کنه — از API خود فیلد استفاده کن
    if (fieldRef.current) {
      fieldRef.current.insertToken(id);
    } else {
      onPartsChange([...parts, { kind: "token", id }]);
    }
    setPatternOpen(false);
  };

  const focusFieldAfterMenu = (e: Event) => {
    // نذار Radix فوکوس رو برگردونه به دکمهٔ Pattern
    e.preventDefault();
    fieldRef.current?.focus();
  };

  const resultLabel =
    resultCount <= 0
      ? "No results"
      : resultIndex < 0
        ? `${resultCount} matches`
        : `${resultIndex + 1} of ${resultCount}`;

  return (
    <TooltipProvider delayDuration={400}>
      <div
        className="absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-2 pointer-events-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div
          className={cn(
            "pointer-events-auto flex w-full max-w-[560px] items-center gap-1.5 rounded-xl border border-border/80",
            "bg-popover/95 px-2 py-1.5 shadow-xl backdrop-blur-md"
          )}
        >
          <Search className="ml-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />

          {/* سطح توکنی — contentEditable، کرسر بین pill و متن طبیعیه */}
          <div className="flex min-h-8 min-w-0 flex-1 items-center rounded-lg border border-border/60 bg-[var(--color-surface-2)] px-2">
            <FindTokenField
              ref={fieldRef}
              parts={parts}
              onPartsChange={onPartsChange}
              focusKey={focusKey}
              placeholder="Find in terminal…"
              onSubmit={(shift) => (shift ? onFindPrevious() : onFindNext())}
              onEscape={onClose}
            />
          </div>

          <Badge
            variant="secondary"
            className={cn(
              "h-6 shrink-0 px-2 text-[11px] font-medium tabular-nums",
              resultCount <= 0 && "text-muted-foreground"
            )}
          >
            {resultLabel}
          </Badge>

          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onFindPrevious}
                  aria-label="Previous match"
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Previous</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onFindNext}
                  aria-label="Next match"
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Next</TooltipContent>
            </Tooltip>
          </div>

          <Separator orientation="vertical" className="mx-0.5 h-5" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Find options"
                title="Options"
              >
                <Settings2 className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Options
              </DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={options.caseInsensitive}
                onCheckedChange={(checked) =>
                  onOptionsChange({ ...options, caseInsensitive: !!checked })
                }
              >
                Case Insensitive
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={options.wrapAround}
                onCheckedChange={(checked) =>
                  onOptionsChange({ ...options, wrapAround: !!checked })
                }
              >
                Wrap Around
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Match
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={options.matchMode}
                onValueChange={(value) =>
                  onOptionsChange({
                    ...options,
                    matchMode: value as FindMatchMode,
                  })
                }
              >
                <DropdownMenuRadioItem value="contains">Contains</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="startsWith">Start with</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="endsWith">End with</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu open={patternOpen} onOpenChange={setPatternOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                aria-label="Match Pattern"
                title="Insert match pattern"
              >
                <Regex className="h-3.5 w-3.5" />
                Pattern
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64"
              onCloseAutoFocus={focusFieldAfterMenu}
            >
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Breaks
              </DropdownMenuLabel>
              {breakPatterns.map((p) => (
                <PatternMenuItem key={p.id} id={p.id} onSelect={insertToken} />
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Character classes
              </DropdownMenuLabel>
              {classPatterns.map((p) => (
                <PatternMenuItem key={p.id} id={p.id} onSelect={insertToken} />
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                Data detectors
              </DropdownMenuLabel>
              {dataPatterns.map((p) => (
                <PatternMenuItem key={p.id} id={p.id} onSelect={insertToken} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onClose}
                aria-label="Close find"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Close</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </TooltipProvider>
  );
}
