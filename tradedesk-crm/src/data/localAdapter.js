// Browser localStorage-backed adapter. This is what makes the app runnable
// standalone with zero backend setup — everything just lives in the browser.
//
// It intentionally has the same tiny shape ({ get(key), set(key, value) })
// that a real backend adapter (Firebase / Supabase / a JobGuzzler REST API)
// would have, so swapping it out later in client.js is a one-line change,
// not a rewrite of the CRM itself.

const PREFIX = "tradedesk:";

export const localAdapter = {
  async get(key) {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) {
      throw new Error("No value stored for key: " + key);
    }
    return { key, value: raw };
  },

  async set(key, value) {
    window.localStorage.setItem(PREFIX + key, value);
    return { key, value };
  },
};
