# Masjidly — docs site

This folder is published as a GitHub Pages static site and serves the App Store
privacy policy, support page, and marketing landing page.

**Live URL (once Pages is enabled):**
`https://ssaud1.github.io/masjidly/`

**Pages available:**

| Path | Purpose |
| --- | --- |
| `/` (index) | Marketing landing page |
| `/privacy.html` | App Store privacy policy URL |
| `/support.html` | App Store support URL |
| `/terms.html` | Terms of use |
| `/delete-account.html` | Apple-required account-deletion instructions |

## Enabling GitHub Pages

1. Push this repo to `ssaud1/masjidly` on GitHub.
2. Go to **Settings → Pages**.
3. Under **Source**, pick **Deploy from a branch**.
4. Branch: `main`, Folder: `/docs`.
5. Save. The site will be live at `https://ssaud1.github.io/masjidly/` in ~1 minute.

The `.nojekyll` file in this folder tells GitHub Pages to serve the HTML as-is
instead of running Jekyll, so everything is plain HTML/CSS and deploys instantly.
