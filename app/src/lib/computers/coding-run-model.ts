import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { toast } from "@/components/ui/toast";
import type { ModelPick } from "@/lib/models/effort";
import { queryClient } from "@/query-client";
import { setCodingConversationModelMutationOptions } from "./desktop-mutations";
import {
  codingConversationModelQueryOptions,
  type CodingConversationChoice,
} from "./desktop-queries";

/** The server reads this saved choice before each turn; no model or credential is sent in chat text. */
export function useCodingConversationModel(
  channelId: string,
  enabled: boolean,
) {
  const saved = useQuery(
    codingConversationModelQueryOptions(channelId, enabled),
  );
  const save = useMutation(
    setCodingConversationModelMutationOptions(queryClient),
  );
  const pending = useRef<Promise<void> | null>(null);
  const catalogue = saved.data?.catalogue;
  const choice = save.isPending ? save.variables.choice : saved.data?.choice;
  const selected =
    catalogue?.models.find((model) => model.id === choice?.model) ??
    catalogue?.models.find((model) => model.id === catalogue.default);
  const change = (next: CodingConversationChoice) => {
    const promise = save.mutateAsync(
      { channelId, choice: next },
      {
        onError: (error) =>
          toast.add({
            id: "coding-conversation-model-save",
            title: error.message,
            type: "error",
          }),
      },
    );
    pending.current = promise;
    void promise.then(
      () => {
        if (pending.current === promise) pending.current = null;
      },
      () => {
        if (pending.current === promise) pending.current = null;
      },
    );
  };
  return {
    catalogue,
    value:
      selected && choice
        ? { model: selected.id, effort: choice.effort }
        : undefined,
    speed: choice?.speed ?? "standard",
    speeds: selected?.speeds ?? ["standard"],
    saving: save.isPending,
    error: saved.error,
    retry: () => saved.refetch(),
    beforeSend: async () => {
      await pending.current;
    },
    choose: (pick: ModelPick) => {
      const model = catalogue?.models.find(
        (option) => option.id === pick.model,
      );
      change({
        model: pick.model,
        effort: pick.effort ?? model?.defaultEffort ?? null,
        speed: model?.speeds?.includes("fast")
          ? (choice?.speed ?? "standard")
          : "standard",
      });
    },
    chooseSpeed: (speed: "standard" | "fast") => {
      if (!selected || !choice) return;
      change({ ...choice, model: selected.id, speed });
    },
  };
}
