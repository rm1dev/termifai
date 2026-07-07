// Copy this file to `oauth_secrets.rs` (same directory) and fill in real values.
// `oauth_secrets.rs` is gitignored — it will never be committed or pushed.
//
//   Google:   https://console.cloud.google.com/apis/credentials
//             -> Create Credentials -> OAuth client ID -> Application type "Desktop app"
//             -> the "Client ID" and "Client secret" are both on that same page.
//   Dropbox:  https://www.dropbox.com/developers/apps -> Create app
//             -> Scoped access -> App folder -> "App key" on the app's Settings tab.

pub const GOOGLE_CLIENT_ID: &str = "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com";
pub const GOOGLE_CLIENT_SECRET: &str = "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_SECRET";
pub const DROPBOX_CLIENT_ID: &str = "REPLACE_WITH_YOUR_DROPBOX_APP_KEY";
