/** Where the app is served from: '' locally, '/a/familycfo' in the hosted image (Vite's `base`). */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** The absolute URL of an API path — how the web app addresses the server, everywhere. */
export const apiUrl = (path: string) => `${BASE_PATH}/api${path}`;
