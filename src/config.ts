export interface Config {
  apiKey: string;
  baseUrl: string;
  defaultProject: string | undefined;
  readOnly: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.FASTSTATS_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "FASTSTATS_API_KEY is not set. Create a key in FastStats settings and add it to the \"env\" block of this server in claude_desktop_config.json.",
    );
  }
  return {
    apiKey,
    baseUrl: (env.FASTSTATS_BASE_URL?.trim() || "https://api.faststats.dev").replace(/\/+$/, ""),
    defaultProject: env.FASTSTATS_DEFAULT_PROJECT?.trim() || undefined,
    readOnly: /^(1|true|yes)$/i.test(env.FASTSTATS_READ_ONLY ?? ""),
  };
}
