import { QueryClient, type DefaultOptions } from "@tanstack/react-query";

export const queryClientDefaultOptions: DefaultOptions = {
  queries: {
    retry: 1,
    staleTime: 30_000,
  },
  mutations: {
    retry: false,
  },
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: queryClientDefaultOptions,
  });
}
