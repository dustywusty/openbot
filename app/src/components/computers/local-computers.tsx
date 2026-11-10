import {
  IconChevronRight,
  IconCode,
  IconCpu,
  IconDeviceDesktop,
  IconFolder,
  IconPackage,
  IconPlug,
  IconPlus,
  IconShieldLock,
  IconTerminal2,
} from "@tabler/icons-react";
import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import {
  PageCard,
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { ComputersPage } from "@/components/manage/computers-page";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { createWorkspaceMutationOptions } from "@/lib/computers/desktop-mutations";
import type { VmRecipe } from "@/lib/computers/desktop-queries";
import { desktopShell } from "@/lib/desktop/shell";
import { queryClient } from "@/query-client";
import { ComputerCodingSection, ComputerSignIn } from "./coding-bot";
import { GuestTerminal } from "./guest-terminal";
import { WorkspaceActions } from "./workspace-actions";
import {
  WorkspaceSkillDetails,
  WorkspaceSkillPicker,
} from "./workspace-skills";

type Recipe = VmRecipe;
const IMAGE_LABELS = { debian13: "Debian 13", ubuntu2404: "Ubuntu 24.04 LTS" };

type Computer = {
  id: string;
  recipe: Recipe;
  phase: string;
  problem: string | null;
  completed: string[];
};
type Progress = { workspaceId: string; stage: string; message: string };
type ListeningPort = {
  port: number;
  address: string;
  process: string | null;
  previewHostPort: number | null;
};
// Keep the persisted native command/record names compatible with already-created VMs.
const native = <T,>(command: string, args?: Record<string, unknown>) =>
  invoke<T>(`plugin:openbot-desktop|workspace_${command}`, args);
const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
const phaseLabel = (phase: string) =>
  phase.charAt(0).toUpperCase() + phase.slice(1);
function Problem({ children }: { children: ReactNode }) {
  return children ? (
    <p className="mt-4 text-sm text-destructive break-words" role="alert">
      {children}
    </p>
  ) : null;
}
function useComputers() {
  const [computers, setComputers] = useState<Computer[]>([]);
  const [problem, setProblem] = useState("");
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    const result = await native<Computer[]>("list");
    setComputers(result);
    setProblem("");
    setLoading(false);
  }, []);
  useEffect(() => {
    if (!desktopShell()) {
      setLoading(false);
      return;
    }
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        if (active) await refresh();
      } catch (error) {
        if (active) {
          setProblem(String(error));
          setLoading(false);
        }
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  return { computers, problem, loading, refresh };
}

export function ComputersHomePage() {
  const desktop = !!desktopShell();
  return (
    <ComputersPage
      localComputers={
        desktop ? (
          <>
            <PageSection
              title="OpenBot’s home"
              description="OpenBot's persistent runtime keeps the app and background Bots running. Workspaces hold project code and development tools."
            >
              <PageRows>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    <IconDeviceDesktop />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>This Mac</ItemTitle>
                    <ItemDescription>
                      OpenBot's services run here, separately from your
                      workspaces.
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button
                      size="sm"
                      variant="outline"
                      render={<Link to="/computers/home" />}
                    >
                      Manage
                    </Button>
                  </ItemActions>
                </Item>
              </PageRows>
            </PageSection>
            <LocalComputersSection />
          </>
        ) : undefined
      }
      action={desktop ? <NewComputerButton /> : undefined}
    />
  );
}
function NewComputerButton() {
  return (
    <Button size="lg" render={<Link to="/computers/new" />}>
      <IconPlus />
      New workspace
    </Button>
  );
}
function LocalComputersSection() {
  const { computers, problem, loading } = useComputers();
  return (
    <PageSection
      title="Workspaces"
      description="Project environments, each running in its own persistent VM. Coding conversations and background Bots can share the same workspace."
    >
      <Problem>{problem}</Problem>
      {loading ? null : problem ? null : computers.length ? (
        <PageRows>
          {computers.map((computer, index) => (
            <Fragment key={computer.id}>
              {index > 0 && <Separator />}
              <Item
                size="sm"
                render={
                  <Link
                    to="/computers/$computerId"
                    params={{ computerId: computer.id }}
                  />
                }
              >
                <ItemMedia variant="icon">
                  <IconDeviceDesktop />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{computer.recipe.name}</ItemTitle>
                  <ItemDescription>
                    VM · {computer.recipe.resources.cpus} CPUs ·{" "}
                    {computer.recipe.resources.memoryGib} GiB memory
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="text-sm text-muted-foreground">
                    {phaseLabel(computer.phase)}
                  </span>
                  <IconChevronRight className="size-4 text-muted-foreground" />
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      ) : (
        <PageEmpty
          icon={IconDeviceDesktop}
          title="No workspaces yet"
          action={<NewComputerButton />}
        >
          Set up a workspace with the packages and tools your project needs.
        </PageEmpty>
      )}
    </PageSection>
  );
}
function Fact({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof IconCpu;
  title: string;
  children: ReactNode;
}) {
  return (
    <Item size="sm">
      <ItemMedia variant="icon">
        <Icon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{title}</ItemTitle>
        <ItemDescription className="line-clamp-none break-words">
          {children}
        </ItemDescription>
      </ItemContent>
    </Item>
  );
}

export function ComputerDetailPage({
  id,
  initialView = "setup",
}: {
  id: string;
  initialView?: "setup" | "shell";
}) {
  const { computers, problem: listProblem, loading, refresh } = useComputers();
  const computer = computers.find((entry) => entry.id === id);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [ports, setPorts] = useState<ListeningPort[]>([]);
  const [portProblem, setPortProblem] = useState("");
  useEffect(() => {
    let active = true;
    if (desktopShell())
      void native<string>("logs", { id })
        .then((output) => {
          if (active) setLog(output);
        })
        .catch((error) => {
          if (active) setProblem(String(error));
        });
    return () => {
      active = false;
    };
  }, [id]);
  useEffect(() => {
    let active = true;
    let reading = false;
    setPorts([]);
    setPortProblem("");
    if (computer?.phase !== "ready") return;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const result = await native<ListeningPort[]>("ports", { id });
        if (active) {
          setPorts(result);
          setPortProblem("");
        }
      } catch (error) {
        if (active) {
          setPorts([]);
          setPortProblem(String(error));
        }
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id, computer?.phase]);
  const operate = async (action: "prepare" | "stop") => {
    setBusy(true);
    setProblem("");
    const events = new Channel<Progress>();
    events.onmessage = (event) =>
      setLog((previous) =>
        `${previous}[${event.stage}] ${event.message}\n`.slice(-128 * 1024),
      );
    try {
      await native(
        action,
        action === "prepare" ? { id, onEvent: events } : { id },
      );
    } catch (error) {
      setProblem(String(error));
    } finally {
      setBusy(false);
      await refresh().catch((error) => setProblem(String(error)));
    }
  };
  return (
    <PageShell
      title={computer?.recipe.name ?? "Computer"}
      backButton={{ label: "Computers", linkProps: { to: "/computers" } }}
      description="Workspace on a persistent VM on this Mac"
      action={
        computer && desktopShell() ? (
          <WorkspaceActions
            id={id}
            name={computer.recipe.name}
            phase={computer.phase}
            busy={busy}
          />
        ) : undefined
      }
    >
      <Problem>{problem || listProblem || computer?.problem}</Problem>
      {!desktopShell() ? (
        <PageEmpty icon={IconDeviceDesktop} title="Open OpenBot Desktop">
          This VM is managed by the desktop app on your Mac.
        </PageEmpty>
      ) : loading ? null : !computer ? (
        <PageEmpty title="VM not found">
          It may be on another desktop.
        </PageEmpty>
      ) : (
        <>
          <ComputerCodingSection
            id={id}
            ready={computer.phase === "ready"}
            hasCodex={!!computer.recipe.tools.codex}
          />
          <ComputerSignIn
            id={id}
            codingEnabled={!!computer.recipe.tools.codex}
          />
          <PageSection title="VM">
            <PageRows>
              <Item size="sm">
                <ItemMedia variant="icon">
                  <IconDeviceDesktop />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{phaseLabel(computer.phase)}</ItemTitle>
                  <ItemDescription>
                    Stopping keeps the project files and installed packages.
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {computer.phase === "ready" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void operate("stop")}
                    >
                      Stop
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void operate("prepare")}
                    >
                      {busy
                        ? "Setting up…"
                        : computer.phase === "failed"
                          ? "Retry setup"
                          : computer.phase === "created"
                            ? "Set up VM"
                            : "Start"}
                    </Button>
                  )}
                </ItemActions>
              </Item>
              <Separator />
              <Fact icon={IconDeviceDesktop} title="Operating system">
                {IMAGE_LABELS[computer.recipe.baseImage]}
              </Fact>
              <Separator />
              <Fact icon={IconCpu} title="Resources">
                {computer.recipe.resources.cpus} CPUs ·{" "}
                {computer.recipe.resources.memoryGib} GiB memory ·{" "}
                {computer.recipe.resources.diskGib} GiB disk
              </Fact>
              <Separator />
              <Fact icon={IconShieldLock} title="Access">
                Project files stay inside this VM. No folders from your Mac are
                mounted.
              </Fact>
            </PageRows>
          </PageSection>
          <PageSection title="Project">
            <PageRows>
              <Fact icon={IconFolder} title="Repository">
                {computer.recipe.repository}
                <br />
                {computer.recipe.gitRef} · /workspace/project
              </Fact>
              <Separator />
              <Fact icon={IconCode} title="Coding tools">
                {[
                  computer.recipe.tools.codex &&
                    `Codex ${computer.recipe.tools.codex}`,
                  computer.recipe.tools.claude &&
                    `Claude Code ${computer.recipe.tools.claude}`,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No coding tools selected"}
              </Fact>
              <Separator />
              <Fact icon={IconPackage} title="System packages">
                {computer.recipe.packages.join(", ")}
              </Fact>
            </PageRows>
          </PageSection>
          <PageSection
            title="Live ports"
            description="Only configured preview ports can be opened from your Mac."
          >
            {ports.length ? (
              <PageRows>
                {ports.map((port, index) => (
                  <Fragment key={`${port.address}:${port.port}`}>
                    {index > 0 && <Separator />}
                    <Item size="sm">
                      <ItemMedia variant="icon">
                        <IconPlug />
                      </ItemMedia>
                      <ItemContent>
                        <ItemTitle>
                          {port.process?.match(/\(\("([^"]+)"/)?.[1] ??
                            "System service"}{" "}
                          · {port.port}
                        </ItemTitle>
                        <ItemDescription>
                          {port.address}
                          {port.previewHostPort
                            ? ` → localhost:${port.previewHostPort}`
                            : " · Inside this VM"}
                        </ItemDescription>
                      </ItemContent>
                      {port.previewHostPort && (
                        <ItemActions>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void invoke("plugin:opener|open_url", {
                                url: `http://localhost:${port.previewHostPort}`,
                              }).catch((error) => setProblem(String(error)))
                            }
                          >
                            Open preview
                          </Button>
                        </ItemActions>
                      )}
                    </Item>
                  </Fragment>
                ))}
              </PageRows>
            ) : (
              <PageEmpty icon={IconPlug}>
                {portProblem ||
                  (computer.phase === "ready"
                    ? "No TCP services are listening."
                    : "Start this VM to see its live ports.")}
              </PageEmpty>
            )}
          </PageSection>
          <WorkspaceSkillDetails skills={computer.recipe.skills ?? []} />
          <PageSection
            title="Shell and setup"
            description="Run commands manually, install packages, or review the setup output."
          >
            <Tabs
              id="computer-shell"
              defaultValue={initialView}
              className="mt-4"
            >
              <TabsList>
                <TabsTrigger value="setup">Setup output</TabsTrigger>
                <TabsTrigger
                  value="shell"
                  disabled={computer.phase !== "ready"}
                >
                  <IconTerminal2 />
                  Shell
                </TabsTrigger>
              </TabsList>
              <TabsContent value="setup">
                <pre className="h-96 overflow-auto rounded-lg border bg-card p-4 text-xs whitespace-pre-wrap break-words">
                  {log ||
                    "Set up this VM to install its packages, tools, and project."}
                </pre>
              </TabsContent>
              {/* The terminal needs a fixed viewport; the surrounding page uses the shared prose layout. */}
              <TabsContent value="shell">
                <div className="rounded-lg border bg-card p-4">
                  <GuestTerminal key={id} id={id} />
                </div>
              </TabsContent>
            </Tabs>
          </PageSection>
        </>
      )}
    </PageShell>
  );
}

export function NewComputerPage() {
  const create = useMutation(createWorkspaceMutationOptions(queryClient));
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [packages, setPackages] = useState("");
  const [changingImage, setChangingImage] = useState(false);
  const [problem, setProblem] = useState("");
  const busy = create.isPending;
  const navigate = useNavigate();
  useEffect(() => {
    if (desktopShell())
      void native<Recipe>("recipe")
        .then((defaults) => {
          setRecipe(defaults);
          setPackages(defaults.packages.join(" "));
        })
        .catch((error) => setProblem(String(error)));
  }, []);
  return (
    <PageShell
      title="New workspace"
      description="Set up a project environment. Choose its VM operating system, resources, packages, and tools."
      backButton={{ label: "Computers", linkProps: { to: "/computers" } }}
    >
      <Problem>{problem}</Problem>
      {!desktopShell() ? (
        <PageEmpty title="Open OpenBot Desktop">
          Create workspaces from the desktop app on your Mac.
        </PageEmpty>
      ) : !recipe ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || changingImage) return;
            const fields = new FormData(event.currentTarget);
            const text = (key: string) => String(fields.get(key) ?? "");
            setProblem("");
            void create
              .mutateAsync({
                slugs: [...selectedSkills],
                recipe: {
                  ...recipe,
                  name: text("name"),
                  repository: text("repository"),
                  gitRef: text("gitRef"),
                  resources: {
                    cpus: Number(text("cpus")),
                    memoryGib: Number(text("memoryGib")),
                    diskGib: Number(text("diskGib")),
                  },
                  tools: {
                    codex: text("codex") || null,
                    claude: text("claude") || null,
                  },
                  packages: text("packages").split(/\s+/).filter(Boolean),
                  setup: lines(text("setup")),
                  verify: lines(text("verify")),
                  ports: lines(text("ports")).map((line) => {
                    const [guest, host] = line.split(":").map(Number);
                    return { guest, host };
                  }),
                },
              })
              .then((computer) =>
                navigate({
                  to: "/computers/$computerId",
                  params: { computerId: computer.id },
                }),
              )
              .catch((error) => setProblem(String(error)));
          }}
        >
          <PageCard
            footer={
              <>
                <Button variant="outline" render={<Link to="/computers" />}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || changingImage}>
                  {busy ? "Creating…" : "Create workspace"}
                </Button>
              </>
            }
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="base-image">Operating system</FieldLabel>
                <FieldDescription>
                  Debian is the default. The OS is fixed when the VM is created.
                </FieldDescription>
                <Select
                  items={IMAGE_LABELS}
                  value={recipe.baseImage}
                  disabled={busy || changingImage}
                  onValueChange={(value) => {
                    if (!value || value === recipe.baseImage) return;
                    setChangingImage(true);
                    setProblem("");
                    void native<Recipe>("recipe", { baseImage: value })
                      .then((defaults) => {
                        setRecipe(
                          (current) =>
                            current && {
                              ...current,
                              baseImage: defaults.baseImage,
                              packages: defaults.packages,
                            },
                        );
                        setPackages(defaults.packages.join(" "));
                      })
                      .catch((error) => setProblem(String(error)))
                      .finally(() => setChangingImage(false));
                  }}
                >
                  <SelectTrigger id="base-image" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="debian13">Debian 13</SelectItem>
                    <SelectItem value="ubuntu2404">Ubuntu 24.04 LTS</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              {(
                [
                  ["name", "Name", recipe.name],
                  ["repository", "Repository", recipe.repository],
                  ["gitRef", "Branch or tag", recipe.gitRef],
                ] as const
              ).map(([name, label, value]) => (
                <Field key={name}>
                  <FieldLabel htmlFor={name}>{label}</FieldLabel>
                  <Input
                    id={name}
                    name={name}
                    required
                    type={name === "repository" ? "url" : "text"}
                    defaultValue={value}
                  />
                </Field>
              ))}
              {(
                [
                  ["cpus", "CPUs", 1, 16],
                  ["memoryGib", "Memory (GiB)", 2, 64],
                  ["diskGib", "Disk (GiB)", 16, 512],
                ] as const
              ).map(([name, label, min, max]) => (
                <Field key={name}>
                  <FieldLabel htmlFor={name}>{label}</FieldLabel>
                  <Input
                    id={name}
                    name={name}
                    type="number"
                    required
                    min={min}
                    max={max}
                    defaultValue={recipe.resources[name]}
                  />
                </Field>
              ))}
              <Field>
                <FieldLabel htmlFor="packages">System packages</FieldLabel>
                <FieldDescription>
                  Package names for the selected OS, separated by spaces.
                  Changing the OS loads its recommended packages. You can
                  install more in the shell later.
                </FieldDescription>
                <Textarea
                  id="packages"
                  name="packages"
                  disabled={changingImage || busy}
                  rows={3}
                  value={packages}
                  onChange={(event) => setPackages(event.target.value)}
                />
              </Field>
              <WorkspaceSkillPicker
                selected={selectedSkills}
                onChange={setSelectedSkills}
                disabled={busy || changingImage}
              />
              {(["codex", "claude"] as const).map((name) => (
                <Field key={name}>
                  <FieldLabel htmlFor={name}>
                    {name === "codex" ? "Codex version" : "Claude Code version"}
                  </FieldLabel>
                  <FieldDescription>
                    Leave empty to skip installation.
                  </FieldDescription>
                  <Input
                    id={name}
                    name={name}
                    defaultValue={recipe.tools[name] ?? ""}
                  />
                </Field>
              ))}
              {(
                [
                  ["setup", "Project setup commands", recipe.setup.join("\n")],
                  ["verify", "Verification commands", recipe.verify.join("\n")],
                  [
                    "ports",
                    "Preview ports",
                    recipe.ports
                      .map((port) => `${port.guest}:${port.host}`)
                      .join("\n"),
                  ],
                ] as const
              ).map(([name, label, value]) => (
                <Field key={name}>
                  <FieldLabel htmlFor={name}>{label}</FieldLabel>
                  <FieldDescription>
                    {name === "ports"
                      ? "One guest:host mapping per line. Previews are exposed on your Mac's localhost."
                      : "One command per line, run from /workspace/project."}
                  </FieldDescription>
                  <Textarea
                    id={name}
                    name={name}
                    rows={3}
                    defaultValue={value}
                  />
                </Field>
              ))}
            </FieldGroup>
          </PageCard>
        </form>
      )}
    </PageShell>
  );
}
