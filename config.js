// ── Client-side config for the Google Drive integration ──
// These are NOT secrets — any browser app exposes them. Security comes from
// restricting them in the Google Cloud Console (the OAuth client is locked to
// your registered origins; restrict the API key to your origins + the Picker
// API). Safe to commit. See SETUP-google-drive.md for how to fill these in.
window.WHITEBOARD_CONFIG = {
  googleClientId: '',   // e.g. "840xxxxxxxxx-abc123.apps.googleusercontent.com"
  googleApiKey: ''      // for the Google file Picker (opening existing/shared files)
};
