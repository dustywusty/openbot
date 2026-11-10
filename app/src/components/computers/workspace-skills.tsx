import { IconBook } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  type WorkspaceSkillSnapshot,
  workspaceSkillsQueryOptions,
} from "@/lib/computers/desktop-queries";

export function WorkspaceSkillPicker({
  selected,
  onChange,
  disabled,
}: {
  selected: string[];
  onChange: (slugs: string[]) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const skills = useQuery(workspaceSkillsQueryOptions(open));
  return (
    <Field>
      <FieldLabel>Skills</FieldLabel>
      <FieldDescription>
        Copy up to 16 skills into this workspace. Only instructions are copied;
        accounts and tool access stay separate.
      </FieldDescription>
      <Button
        variant="outline"
        disabled={disabled}
        onClick={() => setOpen(true)}
        type="button"
      >
        {selected.length
          ? `${selected.length} ${selected.length === 1 ? "skill" : "skills"} selected`
          : "Choose skills"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Choose workspace skills</DialogTitle>
            <DialogDescription>
              Instructions are copied when you create the workspace. Later edits
              to a skill do not change that copy.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="overflow-y-auto">
            {skills.isPending ? null : skills.error ? (
              <p className="mt-4 text-sm text-destructive" role="alert">
                Couldn't list your skills. Close this dialog and try again.
              </p>
            ) : skills.data?.length === 0 ? (
              <PageEmpty title="No skills available">
                Create a skill in OpenBot, then return here to copy it.
              </PageEmpty>
            ) : (
              <PageRows>
                {skills.data?.map((skill, index) => (
                  <Fragment key={skill.slug}>
                    {index > 0 ? <Separator /> : null}
                    <Item size="sm">
                      <ItemContent>
                        <ItemTitle>
                          <label htmlFor={`workspace-skill-${skill.slug}`}>
                            {skill.name}
                          </label>
                        </ItemTitle>
                        <ItemDescription>{skill.description}</ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Checkbox
                          id={`workspace-skill-${skill.slug}`}
                          checked={selected.includes(skill.slug)}
                          disabled={
                            disabled ||
                            (!selected.includes(skill.slug) &&
                              selected.length >= 16)
                          }
                          onCheckedChange={(checked) =>
                            onChange(
                              checked
                                ? [...selected, skill.slug]
                                : selected.filter(
                                    (slug) => slug !== skill.slug,
                                  ),
                            )
                          }
                        />
                      </ItemActions>
                    </Item>
                  </Fragment>
                ))}
              </PageRows>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {selected.length} of 16 selected
            </p>
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Field>
  );
}

export function WorkspaceSkillDetails({
  skills,
}: {
  skills: WorkspaceSkillSnapshot[];
}) {
  if (!skills.length) return null;
  return (
    <PageSection
      title="Skills"
      description="These instruction copies are fixed for this workspace. They do not provide accounts or tool access."
    >
      <PageRows>
        {skills.map((skill, index) => (
          <Fragment key={skill.slug}>
            {index > 0 ? <Separator /> : null}
            <Item size="sm">
              <ItemMedia variant="icon">
                <IconBook />
              </ItemMedia>
              <ItemContent>
                <ItemTitle>{skill.name}</ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {skill.description}
                </ItemDescription>
                <p className="text-xs text-muted-foreground">
                  Copied from {skill.origin} · Skill name: openbot-{skill.slug}
                </p>
                <details className="mt-2 text-xs">
                  <summary className="cursor-pointer">
                    Copied instructions
                  </summary>
                  <p className="mt-2 break-all text-muted-foreground">
                    SHA-256: {skill.sha256}
                  </p>
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                    {skill.instructions}
                  </pre>
                </details>
              </ItemContent>
            </Item>
          </Fragment>
        ))}
      </PageRows>
    </PageSection>
  );
}
