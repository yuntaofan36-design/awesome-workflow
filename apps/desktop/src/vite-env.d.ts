/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly OUTPUT_TARGET?: string;
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_OUTPUT_TARGET?: string;
  readonly VITE_SSO_API_PREFIX?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
