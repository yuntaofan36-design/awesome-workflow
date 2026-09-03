/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_CONTROL_PLANE_MANIFEST_URL?: string;
  readonly VITE_DEMO_IFRAME_URL?: string;
  readonly VITE_INCLUDE_LOCAL_APPS?: string;
  readonly VITE_TRUSTED_FEDERATION_ORIGINS?: string;
  readonly VITE_WEB_PORT?: string;
  readonly VITE_WORKSPACE_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
