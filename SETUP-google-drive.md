# Google Drive setup (one-time)

This connects the whiteboard to **your** Google Drive so boards can sync across
devices and be shared. The app stores nothing on a server — it only reads/writes
the one file you choose, using a temporary token. You do this **once**; everyone
else just clicks "Allow."

You'll end up with two values to paste into [`config.js`](config.js):
a **OAuth Client ID** (for sign-in) and an **API key** (for the file picker).

> Console note: Google is mid-migrating the OAuth screens to the "Google Auth
> Platform" (console.cloud.google.com/auth). Tab names below give the new name
> with the classic "APIs & Services →" path in parentheses.

---

## 1. Create a project
1. Go to <https://console.cloud.google.com>.
2. Top bar → project dropdown → **New Project** → name it (e.g. "Whiteboard") → **Create**, then select it.

## 2. Enable the APIs
**APIs & Services → Library**, then enable each:
- **Google Drive API**
- **Google Picker API**

## 3. Configure the consent screen (who can sign in & what they're asked)
Open **Google Auth Platform** (APIs & Services → OAuth consent screen):
1. **Audience / User type:** choose **External**. (Publishing status stays **Testing** — that's fine, no verification needed, up to 100 users.)
2. **Branding:** set **App name**, **User support email**, **Developer contact email**. Save.
3. **Data Access (Scopes):** Add scope → filter for **`.../auth/drive.file`** → select it → Update/Save. This is the narrow "only files you open with this app" scope.
4. **Audience → Test users:** Add the Google account emails of **yourself and anyone you'll share boards with**. (Only these accounts can use the app while in Testing.)

## 4. Create the OAuth Client ID
**Clients** (APIs & Services → Credentials) → **Create credentials → OAuth client ID**:
1. **Application type:** Web application.
2. **Name:** anything.
3. **Authorized JavaScript origins:** add the exact origin you open the app at — scheme + host + port, **no trailing slash**, **no path**. Examples:
   - Dev: `http://localhost:5500` (use *your* live-server port)
   - Later, prod: `https://your-domain.example`
   - `file://` does **not** work — you must serve over http(s).
4. (Leave "Authorized redirect URIs" empty — not needed for this browser flow.)
5. **Create** → copy the **Client ID** (looks like `840...-abc.apps.googleusercontent.com`).

## 5. Create an API key (for the file picker)
**Credentials → Create credentials → API key** → copy it. Then **Edit** the key:
- **Application restrictions:** choose **Websites** (this is the renamed "HTTP referrers"
  option). Add your origins as referrer patterns with a `/*` suffix, e.g.
  `http://localhost:5500/*` and later `https://your-domain.example/*`.
- **API restrictions:** restrict to **Google Picker API** (and Drive API).

## 6. Paste both into config.js
```js
window.WHITEBOARD_CONFIG = {
  googleClientId: 'PASTE_CLIENT_ID_HERE',
  googleApiKey:   'PASTE_API_KEY_HERE'
};
```

That's it. Reload the app and "Connect Google Drive" will work for you and your
test users. To open the app to the public later (no "unverified app" notice),
submit it for verification — `drive.file` is the light scope and skips the heavy
security review.

## What each value is / isn't
- Both are **public** client-side identifiers, safe to commit. The OAuth client is
  locked to your **registered origins**; the API key is locked to your origins + APIs.
- The app never sees anyone's Google password, and only ever gets `drive.file`
  access. Users can revoke it at myaccount.google.com → Security → Third-party access.
