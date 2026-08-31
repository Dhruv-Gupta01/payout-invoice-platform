import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { ApiError } from "./lib/api";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Found live (Phase 9 manual check): a definitive 4xx (e.g. 404 for
        // an unknown id) was retried 3x with backoff by react-query's
        // default, delaying the error/not-found UI by several seconds for
        // no benefit — retrying can't turn a 404 into a 200. Only retry on
        // everything else (network failures, 5xx).
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            return false;
          }
          return failureCount < 3;
        },
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
