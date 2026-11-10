import { createFileRoute } from "@tanstack/react-router";
import { NewCodingBotPage } from "@/components/computers/coding-bot";
export const Route = createFileRoute(
  "/_authed/_app/computers_/$computerId/new-bot",
)({ component: NewCodingBot });
function NewCodingBot() {
  const { computerId } = Route.useParams();
  return <NewCodingBotPage id={computerId} />;
}
