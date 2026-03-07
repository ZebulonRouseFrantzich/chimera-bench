export interface ServeCliFlags {
  hostname: string;
  port: number;
  corsOrigins: string[];
  mdns: boolean;
  mdnsDomain: string;
}

export interface BasicAuthSettings {
  enabled: boolean;
  username: string;
  password?: string;
  trustProxy?: boolean;
}

export interface ServeConfig {
  hostname: string;
  port: number;
  corsAllowlist: string[];
  mdns: boolean;
  mdnsDomain: string;
  modelRoots: string[];
  workloadRoots: string[];
  auth: BasicAuthSettings;
  startupWarnings: string[];
  version: string;
  devMode: boolean;
}
