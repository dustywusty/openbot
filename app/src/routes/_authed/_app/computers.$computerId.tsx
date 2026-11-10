import { createFileRoute } from "@tanstack/react-router";
import { ComputerDetailPage } from "@/components/computers/local-computers";
import { computerDetailSearch } from "@/lib/computers/vm-target";
export const Route = createFileRoute("/_authed/_app/computers/$computerId")({
  validateSearch: computerDetailSearch,
  component: Detail,
});
function Detail() {
  const { computerId } = Route.useParams();
  const { view } = Route.useSearch();
  return (
    <ComputerDetailPage
      key={`${computerId}:${view}`}
      id={computerId}
      initialView={view}
    />
  );
}
