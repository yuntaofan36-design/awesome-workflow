/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOST_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
