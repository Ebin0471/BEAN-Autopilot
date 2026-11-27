import type { PrivacyClass } from "./types";

/**
 * Secure AI provider configuration.
 *
 * Provider endpoints and credentials are read from environment variables.
 * Credentials are referenced by the provider registry (auth_ref / endpoint_ref)
 * and are NEVER stored in ordinary application records or returned to the
 * browser. No provider is mandatory: when no usable provider is configured,
 * the system reports an honest "model not configured" state.
 */

export interface AIProviderConfig {
  providerId: string;
  providerName: string;
  adapterType: "native" | "openai-compatible" | "local" | "test";
  /** Base URL for compatible/local endpoints. */
  baseUrl: string | null;
  /** Environment variable NAME holding the API key (never the value). */
  apiKeyEnv: string | null;
  privacyClass: PrivacyClass;
  /** Whether this provider is enabled by configuration. */
  enabled: boolean;
}

/**
 * Read provider configuration from the environment. The test provider is always
 * available (deterministic, no credentials). Real providers are opt-in via env.
 */
export function loadProviderConfigs(): AIProviderConfig[] {
  const configs: AIProviderConfig[] = [
    {
      providerId: "test.provider",
      providerName: "BEAN Test Provider",
      adapterType: "test",
      baseUrl: null,
      apiKeyEnv: null,
      privacyClass: "INTERNAL",
      enabled: true,
    },
  ];

  // Optional local / OpenAI-compatible endpoint (opt-in, no mandatory runtime).
  const localBase = process.env.BEAN_AI_LOCAL_BASE_URL;
  if (localBase) {
    configs.push({
      providerId: "local.endpoint",
      providerName: "Local / Self-hosted AI",
      adapterType: "local",
      baseUrl: localBase,
      apiKeyEnv: process.env.BEAN_AI_LOCAL_API_KEY ? "BEAN_AI_LOCAL_API_KEY" : null,
      privacyClass: "LOCAL",
      enabled: true,
    });
  }

  // Optional BEAN Intelligence native adapter (CONFIGURATION_REQUIRED until a
  // real contract is supplied — never pretend it is connected).
  const beanBase = process.env.BEAN_INTELLIGENCE_BASE_URL;
  if (beanBase) {
    configs.push({
      providerId: "bean.intelligence",
      providerName: "BEAN Intelligence",
      adapterType: "native",
      baseUrl: beanBase,
      apiKeyEnv: process.env.BEAN_INTELLIGENCE_API_KEY ? "BEAN_INTELLIGENCE_API_KEY" : null,
      privacyClass: "EXTERNAL",
      enabled: true,
    });
  }

  return configs;
}

/**
 * Resolve a credential value by environment variable NAME. Returns null when
 * unset. The resolved value is used server-side only and never persisted or
 * returned to the client.
 */
export function resolveCredential(envName: string | null): string | null {
  if (!envName) return null;
  const value = process.env[envName];
  return value && value.length > 0 ? value : null;
}

/** True when at least one usable (enabled) provider is configured. */
export function hasConfiguredProvider(): boolean {
  return loadProviderConfigs().some((c) => c.enabled);
}
