import { createFileRoute, redirect } from "@tanstack/react-router";
// Old local builds and the desktop menu may still link here.
export const Route = createFileRoute("/_authed/_app/workspaces")({
  beforeLoad: () => {
    throw redirect({ to: "/computers" });
  },
});
