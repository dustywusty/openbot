import { createFileRoute, redirect } from "@tanstack/react-router";

// Earlier desktop menus and saved links still use this address.
export const Route = createFileRoute("/_authed/settings/this-computer")({
  beforeLoad: () => {
    throw redirect({ to: "/computers/home", replace: true });
  },
});
