// Site settings. None of these are secrets: access is controlled by who the
// Drive folder is shared with and who is a test user on the Google Cloud app.
window.RECIPE_BOX_CONFIG = {
  // Google Cloud > APIs & Services > Credentials > OAuth client ID (Web application)
  clientId: 'PASTE-CLIENT-ID.apps.googleusercontent.com',

  // Logged by setup() in the Apps Script editor
  recipesFileId: 'PASTE-RECIPES-FILE-ID',
  sheetId: 'PASTE-SHEET-ID',
  inboxFolderId: 'PASTE-INBOX-FOLDER-ID',

  siteTitle: 'Recipe Box',

  // Always treated as staples (left out of "goes well with" suggestions),
  // on top of whatever Claude flags as a staple in each recipe.
  extraStaples: ['salt', 'black pepper', 'pepper', 'water', 'oil', 'olive oil', 'vegetable oil',
    'sunflower oil', 'butter', 'plain flour', 'flour', 'sugar', 'caster sugar']
};
