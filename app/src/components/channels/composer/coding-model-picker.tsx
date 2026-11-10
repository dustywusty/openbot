import { Link } from "@tanstack/react-router";
import { ModelPicker } from "@/components/channels/composer/model-picker";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { useCodingConversationModel } from "@/lib/computers/coding-run-model";

export function CodingModelPicker({
  model,
  disabled,
  workspaceId,
}: {
  model: ReturnType<typeof useCodingConversationModel>;
  disabled?: boolean;
  workspaceId: string;
}) {
  if (model.error)
    return (
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <div className="basis-full text-muted-foreground">
          <p role="alert">{model.error.message}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          render={
            <Link
              to="/computers/$computerId"
              params={{ computerId: workspaceId }}
            />
          }
        >
          Open workspace
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void model.retry()}>
          Retry model picker
        </Button>
      </div>
    );
  if (!model.catalogue?.choosable) return null;
  return (
    <div className="flex items-center gap-1">
      <ModelPicker
        catalogue={model.catalogue}
        value={model.value}
        onChange={model.choose}
        disabled={disabled}
        saving={model.saving}
      />
      {model.value && model.speeds.includes("fast") && (
        <Select
          value={model.speed}
          disabled={disabled || model.saving}
          onValueChange={(value) => {
            if (value === "standard" || value === "fast")
              model.chooseSpeed(value);
          }}
        >
          <SelectTrigger size="sm" aria-label="Coding speed for the next turn">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">Standard</SelectItem>
            <SelectItem value="fast">Fast</SelectItem>
          </SelectContent>
        </Select>
      )}
    </div>
  );
}
