# Recipe book

A private recipe website for a small group. People drop recipe files (PDFs, photos of cookbook pages or handwritten cards, Google Docs, Word files) into a shared Google Drive folder. Once an hour a Google Apps Script job sends new files to Claude, which turns each one into a uniform structured recipe. The website (GitHub Pages) has no Google sign-in: everyone types one shared password and their name. The password is checked by a small web app in the same Apps Script project, which reads and writes the Drive folder for the site.

The site is called "Recipe book". The Drive folder, the notes sheet, the Apps Script project and the Cloud project are still called "Recipe Box", and the steps below use those names.

**This repository holds no recipes.** It only holds code, the web app's address and the folder's ID. The web app gives nothing out without the password, and the folder ID is useless without access to the folder.

Features:
- Search by text, course, or by the ingredients you have. Pick an ingredient and the site suggests what usually goes with it, leaving out staples like salt and oil.
- Every recipe has the same layout: photo, prep/cook/total time, servings, ingredients you can tick off, numbered steps.
- A flowchart of the steps that shows what can be done at the same time.
- Shared notes on each recipe, with each person's name on their notes.
- A "Keep screen on" switch for cooking from your phone.
- Cooking mode: one step per screen in large type, readable at arm's length, with the ingredients a tap away. It keeps the screen on and remembers your place.
- Add a recipe on the site from a web address or a file. Recipes added this way are marked, and listed on the review page, so they can be checked or removed.
- The book is saved on each phone, so it opens straight away and works offline.

```
Shared Drive folder "Recipe Box"   <- everyone uploads here (subfolders OK)
├── Lasagne.pdf
├── Lasagne.jpg                    <- same name = photo for that recipe
├── Grandma's scones.jpg           <- a photo of a recipe card is fine too
├── Added from the web/            <- recipes added by web address on the site (created by the job)
├── Uploaded on the website/       <- files uploaded on the site (created by the web app)
├── Recipe Box notes (Sheet)       <- Notes, Status and Links tabs (created by setup and the job)
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
2. Share it with anyone who should be able to add files straight into Drive, as **Editor**. Everyone else only needs the site password.
3. Open the folder and copy its ID from the URL: `drive.google.com/drive/folders/<THIS PART>`.

### 3. The Apps Script job
1. Go to https://script.google.com and click **New project**. Name it "Recipe Box".
2. Under **Project Settings**, tick **Show "appsscript.json" manifest file in editor**.
3. Create the files `Code.gs`, `Site.gs`, `Extract.gs`, `Photos.gs`, `PdfPages.gs` and `appsscript.json` and paste in the contents of the matching files from `apps-script/`.
4. Under **Project Settings > Script properties**, add:
   - `ANTHROPIC_API_KEY`: your key
   - `INBOX_FOLDER_ID`: the folder ID from step 2
   - `SITE_PASSWORD`: the password everyone will type. Four random words is easy to type on a phone and hard to guess. Capitals and extra spaces don't matter.
5. Back in the editor, choose the `setup` function and click **Run**. Approve the permissions; you will see an "unverified app" screen, click **Advanced > Go to Recipe Box**. This is your own script.
6. Open **Execution log** and copy the folder ID it prints for step 5.

`setup` creates the data folder, `recipes.json`, and the notes spreadsheet, and starts the hourly job. To process files straight away, run `processInbox` by hand.

### 4. The website's web app
1. In the Apps Script editor: **Deploy > New deployment**, type **Web app**.
2. **Execute as: Me**, **Who has access: Anyone**. Click **Deploy**.
3. Copy the **Web app URL** (it ends `/exec`).

The web app runs as you, so it can read the folder, but it does nothing until it's given the password.

**After changing any script file**, deploy it again: **Deploy > Manage deployments**, the pencil icon, **Version: New version**, **Deploy**. The address stays the same. Until then the site keeps using the old code. (The hourly job always uses the latest code.)

### 5. Website config and GitHub Pages
1. Fill in `docs/config.js` with the web app URL (as `serviceUrl`) and the folder ID. Commit and push.
2. On GitHub: **Settings > Pages > Build and deployment**: Source **Deploy from a branch**, branch `main`, folder `/docs`.
3. The site appears at `https://<username>.github.io/<repo-name>/`. Add it to everyone's phone home screen.

## Day to day

- **Add a recipe:** upload it to the Recipe Box folder. It shows up within the hour. Or upload it on the site's **Add recipes** page, with a photo of the dish if you like. It goes in the "Uploaded on the website" folder and shows up within a few minutes.
- **Add a recipe from a website:** paste its web address on the site's **Add recipes** page. The address goes in the Links tab of the notes sheet. A few minutes later the job fetches the page, keeps the recipe as a text file (from the recipe data most recipe sites embed, or the page text if there is none) in the "Added from the web" folder, and saves the site's photo of the dish beside it. Some sites refuse to be read, or need a sign-in; for those, save the page as a PDF and upload that instead.
- **Photo of the dish:** if the file contains a photo of the food, it's used automatically: on the recipe card and at the top of the recipe. Claude reports where the photo is on the page; the site cuts it out of a picture of page 1, or uses the original JPEG when the PDF contains one. To use a different photo, upload an image with the same name as the recipe file (`Lasagne.pdf` + `Lasagne.jpg`). With neither, the recipe card shows a picture of the recipe's first page and the recipe page has no photo at the top.
- **Fix a recipe:** edit or replace the file, and it is processed again. **Remove a recipe:** delete the file.
- **Something didn't appear?** The site's **Add recipes** page (and the Status tab of the notes sheet) shows each file's status and any error. A file that fails 3 times is skipped until it changes.
- **Check what was added on the site:** the review page ("See which recipes to check" on **Add recipes**) lists every recipe added on the site, newest first, with who added it and a link to its file. Delete the file to remove the recipe.
- **Change the password** (for example to remove someone's access): change `SITE_PASSWORD` in the script properties. Every device then asks for the new one. No new deployment is needed.
- Anyone with the password can add notes and recipes under any name. Notes can only be deleted from the device that wrote them.

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
- **Web app** (`apps-script/Site.gs`): the site's only way in. Each request carries the password; a wrong one waits 2 seconds before failing. It sends `recipes.json` (only when it has changed), the notes, the status list, and recipe photos (only files that are a recipe's photo, so the password doesn't open the rest of Drive). It adds and deletes notes, adds web addresses, and saves uploads. After a web address or an upload it runs the job about a minute later instead of waiting for the hour.
- **Website** (`docs/`): plain HTML/JS, no build step. It keeps the password, the visitor's name and a random id for the device in the browser. The id goes with each note, so a note can only be deleted from the device that wrote it. The recipes, notes and photos are saved on the device, so the book opens straight away and works offline; the latest is fetched behind it. Mermaid draws the flowcharts.
- **"Original file" links** on recipe pages open the file in Google Drive, so they only work for people the folder is shared with. The Google Cloud project used by the old Google sign-in is no longer needed and can be deleted.
