import { createFileRoute } from "@tanstack/react-router";
import { NewComputerPage } from "@/components/computers/local-computers";
export const Route = createFileRoute("/_authed/_app/computers_/new")({
  component: NewComputerPage,
});
