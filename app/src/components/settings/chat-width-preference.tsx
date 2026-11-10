import { isChatWidth } from "@openbot/shared/user-preferences";
import { IconArrowsHorizontal } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
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
import {
  saveUserPreferencesMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";

const labels = {
  comfortable: "Comfortable",
  wide: "Wide",
  full: "Full",
} as const;

/** Account-scoped; signing out removes the previous person's layout choice. */
export function ChatWidthAccountSync() {
  const saved = useUserPreferences().data?.chatWidth;
  const width = isChatWidth(saved) ? saved : "comfortable";
  useEffect(() => {
    document.documentElement.dataset.chatWidth = width;
    return () => {
      delete document.documentElement.dataset.chatWidth;
    };
  }, [width]);
  return null;
}

export function ChatWidthPreference() {
  const preferences = useUserPreferences();
  const client = useQueryClient();
  const save = useMutation(
    saveUserPreferencesMutationOptions(client, preferences.userId),
  );
  const width = preferences.data?.chatWidth ?? "comfortable";
  return (
    <>
      <Item size="sm">
        <ItemMedia variant="icon">
          <IconArrowsHorizontal />
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Chat width</ItemTitle>
          <ItemDescription>
            Set the width of messages and the message box.
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <Select
            value={width}
            disabled={!preferences.data || save.isPending}
            onValueChange={(value) => {
              if (isChatWidth(value)) save.mutate({ chatWidth: value });
            }}
          >
            <SelectTrigger aria-label="Chat width">
              <SelectValue>{labels[width]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable">Comfortable</SelectItem>
              <SelectItem value="wide">Wide</SelectItem>
              <SelectItem value="full">Full</SelectItem>
            </SelectContent>
          </Select>
        </ItemActions>
      </Item>
      {preferences.isError ? (
        <div className="px-3 pb-3">
          <p role="alert" className="text-sm text-destructive">
            {preferences.error.message}
          </p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void preferences.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : null}
      {save.isError ? (
        <p role="alert" className="px-3 pb-3 text-sm text-destructive">
          {save.error.message}
        </p>
      ) : null}
      {save.isPending ? (
        <p role="status" className="px-3 pb-3 text-sm text-muted-foreground">
          Saving…
        </p>
      ) : null}
    </>
  );
}
