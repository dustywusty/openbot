import { IconChevronDown } from "@tabler/icons-react";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Keep native keyboard and menu behavior, with the same field styling on WebKit and Chromium. */
export function NativeSelect({
  className,
  ...props
}: ComponentProps<"select">) {
  return (
    <span className="relative inline-flex min-w-0">
      <select
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-lg border border-input bg-background py-1.5 pl-3 pr-8 text-sm shadow-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...props}
      />
      <IconChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
