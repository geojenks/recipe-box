# Recipe Box

A private recipe website for a small group. People drop recipe files (PDFs, photos of cookbook pages or handwritten cards, Google Docs, Word files) into a shared Google Drive folder. Once an hour a Google Apps Script job sends new files to Claude, which turns each one into a uniform structured recipe. The website (GitHub Pages) reads those recipes using each person's own Google sign-in, so only people the folder is shared with can see anything.

**This repository holds no recipes.** It only holds code and the IDs of the Drive files, and the IDs are useless without access to the folder.

Features:
- Search by text, course, or by the ingredients you have. Pick an ingredient and the site suggests what usually goes with it, leaving out staples like salt and oil.
- Every recipe has the same layout: photo, prep/cook/total time, servings, ingredients you can tick off, numbered steps.
- A flowchart of the steps that shows what can be done at the same time.
- Shared notes on each recipe, with each person's name on their notes.
- A "Keep screen on" switch for cooking from your phone.

```
Shared Drive folder "Recipe Box"   <- everyone uploads here (subfolders OK)
├── Lasagne.pdf
├── Lasagne.jpg                    <- same name = photo for that recipe
├── Grandma's scones.jpg           <- a photo of a recipe card is fine too
├── Recipe Box notes (Sheet)       <- Notes tab + Status tab (created by setup)
└── _website data (do not edit)/   <- recipes.json + generated photos (created by setup)

apps-script/   background job (copy into script.google.com)
docs/          the website (served by GitHub Pages)
tools/         test the Claude extraction locally
```

## Setup (about 30 minutes, once)

### 1. Claude API key
1. Go to https://console.anthropic.com, add billing, and create an API key.
2. Cost: about 2–4p per recipe file, charged once when the file is processed. Viewing the site costs nothing.

### 2. The shared Drive folder
1. In Google Drive, create a folder called **Recipe Box**.
2. Share it with the other 4 people as **Editor**, so they can upload files and add notes.
3. Open the folder and copy its ID from the URL: `drive.google.com/drive/folders/<THIS PART>`.

### 3. The Apps Script job
1. Go to https://script.google.com and click **New project**. Name it "Recipe Box".
2. Under **Project Settings**, tick **Show "appsscript.json" manifest file in editor**.
3. Create the files `Code.gs`, `Extract.gs`, `Photos.gs`, `PdfPages.gs` and `appsscript.json` and paste in the contents of the matching files from `apps-script/`.
4. Under **Project Settings > Script properties**, add:
   - `ANTHROPIC_API_KEY`: your key
   - `INBOX_FOLDER_ID`: the folder ID from step 2
5. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions; you will see an "unverified app" screen, click **Advanced > Go to Recipe Box**. This is your own script.
6. Open **Execution log** and copy the three IDs it prints for the next steps.

`setup` creates the data folder, `recipes.json`, and the notes spreadsheet, and starts the hourly job. To process files straight away, run `processInbox` by hand.

### 4. Google sign-in for the website
1. Go to https://console.cloud.google.com and create a project called "Recipe Box".
2. **APIs & Services > Library**: enable the **Google Drive API** and the **Google Sheets API**.
3. **APIs & Services > OAuth consent screen** (shown as "Google Auth Platform"):
   - User type **External**, app name "Recipe Box", your email for the contact fields.
   - **Data access / Scopes**: click **Add or remove scopes**, and in **Manually add scopes** paste these two full addresses, then **Add to table** and **Update**:
     ```
     https://www.googleapis.com/auth/drive.readonly
     https://www.googleapis.com/auth/spreadsheets
     ```
   - **Audience / Test users**: add all 5 Google accounts. Leave the app in **Testing** mode. Only these accounts can sign in.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**:
   - Type **Web application**.
   - **Authorised JavaScript origins**: `https://<your-github-username>.github.io` (and `http://localhost:8000` if you want to test locally).
   - Copy the **Client ID**.

When someone first signs in, Google warns "Google hasn't verified this app". That is expected for a private app in Testing mode; they click **Continue**.

### 5. Website config and GitHub Pages
1. Fill in `docs/config.js` with the client ID and the three IDs from the setup log. Commit and push.
2. On GitHub: **Settings > Pages > Build and deployment**: Source **Deploy from a branch**, branch `main`, folder `/docs`.
3. The site appears at `https://<username>.github.io/<repo-name>/`. Add it to everyone's phone home screen.

## Day to day

- **Add a recipe:** upload it to the Recipe Box folder. It shows up within the hour.
- **Photo of the dish:** if the file contains a photo of the food, it's used automatically: on the recipe card and at the top of the recipe. Claude reports where the photo is on the page; the site cuts it out of a picture of page 1, or uses the original JPEG when the PDF contains one. To use a different photo, upload an image with the same name as the recipe file (`Lasagne.pdf` + `Lasagne.jpg`). With neither, the recipe card shows a picture of the recipe's first page and the recipe page has no photo at the top.
- **Fix a recipe:** edit or replace the file, and it is processed again. **Remove a recipe:** delete the file.
- **Something didn't appear?** The site's **Add recipes** page (and the Status tab of the notes sheet) shows each file's status and any error. A file that fails 3 times is skipped until it changes.
- **Remove someone's access:** unshare the folder and remove them from the test users.

## Testing the extraction locally

This sends files through exactly the same prompt and schema the Apps Script job uses:

```sh
ANTHROPIC_API_KEY=sk-ant-... node tools/test-extract.mjs samples/*.pdf
```

It prints what it found in each file, saves `<file>.recipe.json` next to each one, and writes `docs/demo/recipes.json`. To look at the results in the real site layout:

```sh
cd docs && python3 -m http.server 8000
# open http://localhost:8000/?demo
```

Don't commit real recipes in `docs/demo/recipes.json`, because GitHub Pages would make them public. Run `git checkout docs/demo/recipes.json` to restore the sample data.

## How it works

- **Extraction** (`apps-script/Extract.gs`): Claude Sonnet 5.5 with structured outputs, so every recipe comes back in exactly the same JSON shape. The request also turns on Anthropic's server-side fallback, so if a safety check wrongly declines a recipe, another model retries it automatically. To change model, edit `CLAUDE_MODEL`. For each ingredient Claude also returns a plain search name (`"2 red onions, sliced"` becomes `red onion`) and a staple flag. For each step it returns which earlier steps it depends on, and the flowchart is drawn from those links. It also returns the author, the book or website, a printed web address, and where the dish photo is. Clicking an author or book on the site lists all their recipes. Changing the extraction format means bumping `EXTRACT_VERSION` in `Code.gs`, which re-processes every file once.
- **Photos** (`apps-script/Photos.gs`): when Claude says there's a dish photo, this pulls the largest reasonably-shaped JPEG out of the PDF (skipping logos, banners, and scanned PDFs where the biggest image is the whole page). If there isn't a usable JPEG, the job saves a picture of the page the photo is on and the website cuts out the box Claude gave. Drive only renders the first page of a file, so for later pages `PdfPages.gs` copies that page into a temporary one-page PDF (using pdf-lib), waits for Drive to render it, then deletes it. If Drive hasn't rendered it within about 30 seconds, the recipe keeps a picture of page 1 and the next run tries again. Bumping `PHOTO_VERSION` in `Code.gs` redoes every photo without calling Claude. Check what it would pick with `node tools/test-photos.mjs samples/*.pdf`.
- **Job** (`apps-script/Code.gs`): runs hourly under a lock. Each run works for up to 4.5 minutes and saves after every file. If files are left over, it schedules itself to carry on a minute later, and the Status tab lists them as "waiting". It notices new, changed and deleted files.
- **Website** (`docs/`): plain HTML/JS, no build step. It signs in with Google Identity Services and then reads `recipes.json` and photos from the Drive API, and reads and writes notes through the Sheets API, all with the visitor's own token. Mermaid draws the flowcharts.
