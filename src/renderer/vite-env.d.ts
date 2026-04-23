/// <reference types="vite/client" />

declare global {
  interface Window {
    crossfadio: {
      getRuntimeConfig: () => {
        baseUrl: string;
        wsUrl: string;
        sessionToken: string;
      };
      requestLocalApi: (
        path: string,
        method?: string
      ) => Promise<{
        ok: boolean;
        status: number;
        contentType: string;
        text: string;
      }>;
    };
  }
}

export {};
