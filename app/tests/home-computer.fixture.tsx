import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { HomeComputerPage } from "@/components/computers/home-computer";
import { queryClient } from "@/query-client";
import { Route as LegacyComputerRoute } from "@/routes/_authed/settings/this-computer";

/** Exercise desktop controls in their real page frame, including the Computers back link. */
export function renderHomeComputerPage(initialPath = "/computers/home") {
  const root = createRootRoute({ component: Outlet });
  const home = createRoute({
    getParentRoute: () => root,
    path: "/computers/home",
    component: HomeComputerPage,
  });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/computers",
    component: () => <p>Computers overview</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([
      home,
      list,
      createRoute({
        getParentRoute: () => root,
        path: "/settings/this-computer",
        beforeLoad: () => {
          const redirectLegacy = LegacyComputerRoute.options
            .beforeLoad as () => void;
          redirectLegacy();
        },
      }),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
    router,
  };
}
