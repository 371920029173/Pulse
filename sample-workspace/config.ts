/**
 * Application configuration module.
 * Demonstrates a typed config pattern for KB ingestion testing.
 */

interface AppConfig {
  port: number;
  database: {
    host: string;
    port: number;
    name: string;
    maxConnections: number;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'pretty';
  };
  features: {
    enableCache: boolean;
    cacheMaxAge: number;
    enableRateLimit: boolean;
    rateLimitPerMinute: number;
  };
}

const defaultConfig: AppConfig = {
  port: 3000,
  database: {
    host: 'localhost',
    port: 5432,
    name: 'myapp',
    maxConnections: 10,
  },
  logging: {
    level: 'info',
    format: 'json',
  },
  features: {
    enableCache: true,
    cacheMaxAge: 3600,
    enableRateLimit: true,
    rateLimitPerMinute: 100,
  },
};

function loadAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    ...defaultConfig,
    ...overrides,
    database: { ...defaultConfig.database, ...overrides?.database },
    logging: { ...defaultConfig.logging, ...overrides?.logging },
    features: { ...defaultConfig.features, ...overrides?.features },
  };
}

export { loadAppConfig, defaultConfig };
export type { AppConfig };
