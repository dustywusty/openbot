import { IconChartBar, IconRefresh } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { desktopShell } from "@/lib/desktop/shell";
import {
  observedLabel,
  reportedUsedPercent,
  resetLabel,
} from "@/lib/service-usage/format";
import { refreshServiceUsageMutationOptions } from "@/lib/service-usage/mutations";
import {
  type ServiceUsage,
  serviceUsageQueryOptions,
} from "@/lib/service-usage/queries";
import { queryClient } from "@/query-client";

const STATUS_LABELS: Record<ServiceUsage["status"], string> = {
  available: "Usage not reported",
  "not-reported": "Usage not reported",
  "sign-in-required": "Not connected",
  unavailable: "Usage unavailable",
  "not-installed": "Connection unavailable",
  unsupported: "Usage not supported",
};

/** Only connections OpenBot knows about for the signed-in viewer. */
export function UsageMonitor() {
  return desktopShell() ? <DesktopUsageMonitor /> : null;
}
function DesktopUsageMonitor() {
  const [open, setOpen] = useState(false);
  const user = useQuery(currentUserQueryOptions()).data;
  const usage = useQuery(serviceUsageQueryOptions(open, user?.id));
  const refresh = useMutation(
    refreshServiceUsageMutationOptions(queryClient, user?.id),
  );
  const now = Date.now() / 1000;
  return (
    <SidebarMenuItem>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<SidebarMenuButton className="hover:bg-foreground/5 h-10" />}
        >
          <div className="size-[28px] flex items-center justify-center">
            <IconChartBar />
          </div>
          <span className="text-sm">Usage</span>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-80 max-h-[70dvh] overflow-y-auto p-4 gap-4"
        >
          <PopoverHeader>
            <div className="flex items-center justify-between gap-2">
              <PopoverTitle>Usage</PopoverTitle>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Refresh usage"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                <IconRefresh />
              </Button>
            </div>
            <PopoverDescription>
              Accounts used by OpenBot and your coding Bots.
            </PopoverDescription>
          </PopoverHeader>
          {refresh.isPending ? (
            <p className="text-xs text-muted-foreground">Refreshing usage…</p>
          ) : null}
          {refresh.error ? (
            <p role="alert" className="text-xs text-destructive">
              Couldn't refresh usage. Try again.
            </p>
          ) : null}
          {usage.isPending ? null : usage.error ? (
            <p role="alert" className="text-sm text-destructive">
              Could not read your OpenBot connections. Try refreshing.
            </p>
          ) : usage.data?.services.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No model accounts are connected to OpenBot for this account.
            </p>
          ) : (
            <>
              {usage.data?.services.map((service, index) => (
                <div key={service.id} className="space-y-3">
                  {index > 0 ? <Separator /> : null}
                  <UsageServiceRow service={service} now={now} />
                </div>
              ))}
              {usage.data ? (
                <p className="text-xs text-muted-foreground">
                  {observedLabel(usage.data.observedAt, now)}
                </p>
              ) : null}
            </>
          )}
        </PopoverContent>
      </Popover>
    </SidebarMenuItem>
  );
}
export function UsageServiceRow({
  service,
  now,
}: {
  service: ServiceUsage;
  now: number;
}) {
  return (
    <section aria-label={`${service.displayName} usage`} className="space-y-2">
      <div>
        <h3 className="font-medium">{service.displayName}</h3>
        <p className="text-xs text-muted-foreground">{service.source}</p>
        {service.accountName ? (
          <p className="truncate text-xs" title={service.accountName}>
            {service.accountName}
          </p>
        ) : null}
      </div>
      {service.status !== "available" || service.windows.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {STATUS_LABELS[service.status]}
        </p>
      ) : (
        service.windows.map((window) => {
          const used = reportedUsedPercent(window.usedPercent);
          return (
            <div key={window.id} className="space-y-1">
              <div className="flex justify-between gap-2 text-xs">
                <span>{window.label || "Reported allowance"}</span>
                <span>
                  {used === null ? "Not reported" : `${Math.round(used)}% used`}
                </span>
              </div>
              {used === null ? null : (
                <div
                  role="progressbar"
                  aria-label={`${window.label || "Reported allowance"} used`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={used}
                  aria-valuetext={`${used}% used`}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                >
                  <div
                    aria-hidden="true"
                    className={`h-full ${used >= 90 ? "bg-destructive" : "bg-primary"}`}
                    style={{ width: `${used}%` }}
                  />
                </div>
              )}
              <p
                className="text-xs text-muted-foreground"
                title={
                  window.resetAt === null
                    ? undefined
                    : new Date(window.resetAt * 1000).toLocaleString()
                }
              >
                {resetLabel(window.resetAt, now)}
              </p>
            </div>
          );
        })
      )}
      {service.message ? (
        <p className="text-xs text-muted-foreground">{service.message}</p>
      ) : null}
      {service.accountUrl ? (
        <a
          className="text-xs underline underline-offset-4"
          href={service.accountUrl}
          target="_blank"
          rel="noreferrer"
        >
          Manage {service.displayName} account
        </a>
      ) : null}
    </section>
  );
}
