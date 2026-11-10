import { IconBolt, IconChartBar, IconDeviceDesktop } from "@tabler/icons-react";
import { createRoot } from "react-dom/client";
import { SidebarShell } from "../src/components/layout/sidebar-shell";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "../src/components/ui/sidebar";

createRoot(document.getElementById("root")!).render(
  <SidebarShell className="h-svh overflow-hidden" name="app" width="340px">
    <Sidebar variant="inset">
      <SidebarHeader>
        <div className="h-10">OpenBot</div>
      </SidebarHeader>
      <SidebarContent>
        <p>Conversations</p>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          {[
            ["Bots", IconBolt],
            ["Computers", IconDeviceDesktop],
            ["Usage", IconChartBar],
          ].map(([label, Icon]) => (
            <SidebarMenuItem key={String(label)}>
              <SidebarMenuButton className="h-10">
                <div className="size-[28px] flex items-center justify-center">
                  <Icon />
                </div>
                <span className="text-sm">{String(label)}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton className="h-10" aria-label="Account menu">
              <div className="size-7 shrink-0 rounded-full">C</div>
              <span className="grid min-w-0 flex-1 grid-cols-[4fr_1fr] items-center gap-2">
                <span className="truncate text-sm">
                  A person with a very long account name
                </span>
                <span className="text-right text-[10px] leading-3 text-muted-foreground">
                  1.0.1-internal
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
    <SidebarInset>
      <p>Project work</p>
    </SidebarInset>
  </SidebarShell>,
);
