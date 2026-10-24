# Family Expenses

A phone-friendly web app for the **Family Expenses** Google Sheet.

- **Add** an expense in a few taps: amount, category tile, who, payment method. Tiles use the same colors as the CATEGORY dropdown in the sheet, and frequent entries can be repeated with one tap.
- **Overview** shows where the month's money went: by category, by day, by person, by payment method, top places, and month by month.
- **History** lets you search, edit, or delete any expense. Changes go straight into the sheet.
- It works on phones and computers, installs on the home screen, and keeps expenses on the phone when there's no signal, syncing them later.

```
GitHub Pages (docs/)  ──POST──▶  Apps Script web app (apps-script/Code.gs)  ──▶  Family Expenses sheet
   the app you open                 attached to the spreadsheet, needs a PIN        OCT 26, NOV 26, …
```

Nothing personal is stored in this repository. Each device types the web app URL and PIN once.

---

## 1. Add the backend to the spreadsheet (about 5 minutes)

1. Open the **Family Expenses** spreadsheet and choose **Extensions → Apps Script**.
2. In the editor, select everything in `Code.gs`, delete it, and paste the contents of [`apps-script/Code.gs`](apps-script/Code.gs). Press **Save**.
3. *(Optional, recommended)* Click **Project Settings** (gear icon), tick **Show "appsscript.json" manifest file in editor**, open `appsscript.json`, and replace its contents with [`apps-script/appsscript.json`](apps-script/appsscript.json). Save.
4. Go back to the spreadsheet tab and **reload** it. A new menu **Expense App** appears after a few seconds.
5. Choose **Expense App → Set app PIN…** and pick a 6 to 12 digit PIN.
   The first time, Google asks for permission. Click **Continue**, choose your account, then **Advanced → Go to … (unsafe) → Allow**. It says "unsafe" because the script is your own and Google hasn't reviewed it.
6. Choose **Expense App → Check setup**. It should list your month tabs (AUG 26, SEP 26, OCT 26) and the categories.
7. Back in the Apps Script editor, click **Deploy → New deployment**.
   - Click the gear next to "Select type" and choose **Web app**.
   - **Execute as:** Me
   - **Who has access:** **Anyone**
   - Click **Deploy** and copy the **Web app URL**. It ends in `/exec`.

> **Why "Anyone"?** The phone app talks to the script directly, without a Google sign-in. The PIN is what protects it: wrong PINs are rejected, and after 10 wrong tries the script locks for 15 minutes. Don't share the URL and PIN together outside the family.

## 2. Put the app on GitHub Pages

1. Create a new repository on GitHub, for example `family-expenses`. It can be public, because no data or secrets are in the code. GitHub Pages on a private repository needs a paid GitHub plan.
2. Upload everything in this folder: on the repository page, **Add file → Upload files**, then drag in `README.md` and the folders `docs`, `apps-script`, and `.github`. Or use `git push`.
3. Open **Settings → Pages**. Under **Build and deployment**, set **Source** to **Deploy from a branch**, **Branch** to `main`, and the folder to **`/docs`**. Click **Save**.
4. After about a minute the app is live at `https://<your-username>.github.io/family-expenses/`.

## 3. Connect each phone

1. Open the GitHub Pages link on the phone.
2. Paste the **Web app URL**, type the **PIN**, tap **Connect**, and choose whose phone it is (Irvan, Farah…). That person becomes the default for "Whose expense".
3. Install it like an app:
   - **Android (Chrome):** menu ⋮ → **Install app** or **Add to Home screen**.
   - **iPhone (Safari):** Share button → **Add to Home Screen**.
4. For the second phone, open **Settings → Copy setup link** and send it over. The link fills in the URL, so they only need to type the PIN.

*Optional:* paste the web app URL into [`docs/config.js`](docs/config.js) and every device will only ask for the PIN.

---

## How it works with your sheet

| | |
|---|---|
| **Where rows go** | Each expense goes to the month tab that matches its date (`OCT 26`, `NOV 26`, …), in the first empty row after the last expense. |
| **Columns** | Columns are found by their header (DATE OF PAYMENT, WHOM, METHOD OF PAYMENT, PAID TO, CATEGORY, DESCRIPTION, AMOUNT PAID), so `AUG 26`, which has no WHOM column, still works. |
| **Formats** | Dates are written as real dates (`dd/mm/yy`) and amounts as numbers (`#,##0`), so your `SUM` totals and the DASH formulas keep working. Text is saved in upper case, like the rest of the sheet. |
| **Categories & people** | These are read from the CATEGORY and WHOM dropdowns of the newest month tab. To add a category, add it to the dropdown (**Data → Data validation**) and tap refresh in the app. New categories get one of a few standard colors. |
| **New month** | The first expense dated in a new month creates its tab: the newest month tab is copied, its rows are cleared, and the title cell (for example `NOVEMBER 2026`) is updated. You can also use **Expense App → Create next month tab**. |
| **DASH tab** | Not touched. Its formulas point at specific months, so add new sections there as before, or use the app's Overview. |
| **Edits & deletes** | Editing in the app changes the row in place. If you change the date to another month, the row moves to that tab. Deleting removes the row. The script checks the row still matches before changing it, so nothing gets overwritten if someone edited the sheet in the meantime. |
| **Duplicates** | Every save carries an ID, so a retry after a bad connection never adds the same expense twice. |

## Updating the backend later

After changing `Code.gs`: **Deploy → Manage deployments → ✏️ (edit) → Version: New version → Deploy**. The URL stays the same. Choosing *New deployment* instead creates a new URL, and every phone would have to reconnect.

### Optional: deploy the backend from GitHub automatically

The workflow in [`.github/workflows/deploy-apps-script.yml`](.github/workflows/deploy-apps-script.yml) pushes `apps-script/` to your Apps Script project whenever you change it on `main`. It does nothing until you add these secrets:

1. Turn on the Apps Script API: <https://script.google.com/home/usersettings>.
2. On a computer with Node.js installed, run `npm install -g @google/clasp@2.4.2`, then `clasp login`. Copy the whole contents of the file `~/.clasprc.json`.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:
   - `CLASPRC_JSON`: the contents of `~/.clasprc.json`
   - `SCRIPT_ID`: from Apps Script **Project Settings → Script ID**
   - `DEPLOYMENT_ID`: from **Deploy → Manage deployments** (the long ID of your web app deployment)

`CLASPRC_JSON` gives access to your Apps Script projects. Only add it to a repository you control, and remove it if you stop using the workflow.

---

## Troubleshooting

| Message | What to do |
|---|---|
| *Could not reach the web app* | In **Deploy → Manage deployments**, check that access is **Anyone** and the URL ends in `/exec`. |
| *Wrong PIN* / *Too many wrong PINs* | Check the PIN, or wait 15 minutes. Use **Expense App → Set app PIN…** to change it. |
| *"SNACK" is not in the CATEGORY dropdown on tab AUG 26* | Older tabs have their own dropdown. Add the category to that tab's dropdown, or pick another category. |
| *No PIN has been set yet* | Use **Expense App → Set app PIN…** in the spreadsheet. |
| Changes to `Code.gs` don't show up | Publish a new version (see "Updating the backend later"). |
| The app shows old data | Tap the refresh button at the top. The app also refreshes when you come back to it after a couple of minutes. |

Try it without connecting anything: open the app and tap **Try it with sample data first**.

## Files

```
docs/                 ← the web app (GitHub Pages serves this folder)
  index.html          the whole app: layout, styles and code
  config.js           optional default web app URL
  manifest.webmanifest, sw.js, icons/   install-on-home-screen + offline support
apps-script/
  Code.gs             the backend (paste into Extensions → Apps Script)
  appsscript.json     time zone + web app settings
.github/workflows/
  deploy-apps-script.yml   optional auto-deploy of the backend with clasp
```
