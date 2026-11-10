import { createFileRoute } from "@tanstack/react-router";
import { redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/settings/_personal/computer")({
  beforeLoad: () => {
    throw redirect({ to: "/computers" });
  },
});
