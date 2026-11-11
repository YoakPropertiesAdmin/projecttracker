/**
 * GoHighLevel Custom Page sign-in.
 *
 * When TradeDesk is opened from the Renew sidebar in GHL it runs inside GHL's
 * iframe. GHL will tell an embedded app who is looking at it: we post
 * REQUEST_USER_DATA to the parent window and GHL answers with an encrypted
 * blob. Only our backend (td-sso) can decrypt it — it holds the app's Shared
 * Secret — and it answers with a normal Supabase session for the matching
 * TradeDesk login. Nothing secret ever reaches the browser.
 *
 * Unknown GHL users are refused by td-sso; nobody is created here.
 */

/** True when TradeDesk is running inside another site's frame (GHL). */
export function isEmbedded() {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent: reading window.top throws, which itself means framed.
    return true;
  }
}

/** True on the /embed route, the URL the GHL Custom Page points at. */
export function isEmbedRoute() {
  return typeof window !== "undefined" && window.location.pathname.replace(/\/+$/, "") === "/embed";
}

/** Ask GHL's parent window for the encrypted user blob. */
function requestUserData(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error("GoHighLevel did not answer. Reload the page from the GoHighLevel sidebar."));
    }, timeoutMs);

    function onMessage({ data }) {
      if (!data || data.message !== "REQUEST_USER_DATA_RESPONSE") return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      if (typeof data.payload === "string" && data.payload) resolve(data.payload);
      else reject(new Error("GoHighLevel sent no user data."));
    }

    window.addEventListener("message", onMessage);
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
  });
}

/**
 * Sign in through GHL. Resolves { access_token, refresh_token } or throws an
 * Error whose message is fit to show the person.
 */
export async function ghlSignIn() {
  const encryptedData = await requestUserData();
  const base = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${base}/functions/v1/td-sso`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ encryptedData }),
  });
  let body = {};
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok || !body.access_token) {
    throw new Error(body.error || `Sign-in through GoHighLevel failed (HTTP ${res.status}).`);
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token };
}
