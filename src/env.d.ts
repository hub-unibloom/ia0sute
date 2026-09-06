/// <reference types="astro/client" />

interface Fetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface Env {
  EVERMIND_WORKER?: Fetcher;
  EVEROS_API_KEY?: string;
  EVEROS_BASE_URL?: string;
  [key: string]: any;
}

declare namespace App {
  interface Locals {
    runtime?: {
      env?: Env;
      cf?: Record<string, any>;
      ctx?: {
        waitUntil(promise: Promise<any>): void;
      };
    };
  }
}
