import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { PageCard, PageShell } from "@/components/layout/page-shell";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { ProfileNameForm } from "./profile";

/** Existing installs can have completed onboarding before its name step was added. */
export function ProfileNameGate({ children }: { children: ReactNode }) {
  const { data: user } = useQuery(currentUserQueryOptions());
  if (user?.needsName === true && user.onboarding?.completedAt != null) {
    return (
      <PageShell
        title="What should we call you?"
        description="Choose the name OpenBot shows for you. You can change it in Settings later."
      >
        <PageCard>
          <ProfileNameForm key={user.id} />
        </PageCard>
      </PageShell>
    );
  }
  // The address stays where the person was going. Saving refreshes /api/me, so that same
  // screen opens immediately without replaying onboarding or changing its completed state.
  return children;
}
