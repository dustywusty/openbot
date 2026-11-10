import { createFileRoute } from "@tanstack/react-router";
import { HomeComputerPage } from "@/components/computers/home-computer";

export const Route = createFileRoute("/_authed/_app/computers_/home")({
  component: HomeComputerPage,
});
