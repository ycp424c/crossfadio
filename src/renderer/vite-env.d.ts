/// <reference types="vite/client" />

declare global {
  interface Window {
    crossfadio: {
      getRuntimeConfig: () => {
        baseUrl: string;
        wsUrl: string;
        sessionToken: string;
      };
    };
  }
}

export {};
