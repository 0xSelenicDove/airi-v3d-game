/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_LLM_URL?: string
  readonly VITE_LLM_MODEL?: string
  readonly VITE_LLM_KEY?: string
  readonly VITE_LLM_SYSTEM_ROLE?: string
}
