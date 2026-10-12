/** Running as a container behind the apps gateway: no host machine, no login, one household per
 *  container. Set by the image, never by a local checkout. */
export const HOSTED = process.env.HOSTED === '1';

const flag = (name: string, fallback: boolean) => {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v !== '0';
};

/**
 * What this process offers. `chat` needs the host machine (it spawns the user's own `claude` CLI
 * and the tsx-run MCP server from source), so it is off hosted and cannot be turned on there.
 * `scrape` is off by default hosted — a bare `docker run` is inert — and the gateway's instance env
 * file turns it on, which is what lets a visitor connect their own bank.
 */
export const FEATURES = {
  scrape: flag('FEATURE_SCRAPE', !HOSTED),
  chat: HOSTED ? false : flag('FEATURE_CHAT', true),
};
