import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { BUSINESS_URL } from "@/lib/openbot-for-business";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { cn } from "@/lib/utils";

/**
 * The home page's link to OpenBot for Business, in the personal edition only.
 *
 * Hidden until the deployment says which edition it is, so it never flashes on a team deployment.
 */
export function BusinessLink() {
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const queryClient = useQueryClient();
  const dismiss = useMutation(
    dismissSelfHostBannerMutationOptions(queryClient, userId),
  );

  if (
    capabilities?.edition !== "personal" ||
    !preferences ||
    preferences.selfHostBannerDismissed
  )
    return null;

  return (
    <span className="flex items-center gap-0.5">
      {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
      <a
        className={cn(
          buttonVariants({ size: "sm", variant: "ghost" }),
          "text-muted-foreground",
        )}
        href={BUSINESS_URL}
        rel="noopener noreferrer"
        target="_blank"
      >
        Meet OpenBot for Business
      </a>
      <Button
        aria-label="Close"
        className="text-muted-foreground"
        onClick={() => dismiss.mutate()}
        disabled={dismiss.isPending}
        size="icon-xs"
        variant="ghost"
      >
        <IconX />
      </Button>
      {dismiss.isError ? (
        <span role="alert" className="text-xs text-destructive">
          Could not save your choice. Close it again to retry.
        </span>
      ) : null}
    </span>
  );
}
