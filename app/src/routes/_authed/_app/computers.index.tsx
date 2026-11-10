import { createFileRoute } from "@tanstack/react-router";
import { ComputersHomePage } from "@/components/computers/local-computers";
export const Route = createFileRoute("/_authed/_app/computers/")({
  component: ComputersHomePage,
});
