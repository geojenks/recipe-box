// Site settings. None of these are secrets: access is controlled by who the
// Drive folder is shared with and who is a test user on the Google Cloud app.
window.RECIPE_BOX_CONFIG = {
  // Google Cloud > APIs & Services > Credentials > OAuth client ID (Web application)
  clientId: '265100605111-vpc1mbo7mub2n90gh5vvenv63ta88gru.apps.googleusercontent.com',

  // Logged by setup() in the Apps Script editor
  recipesFileId: '1u24tIFe4KCuOS2bSrVDM_GzAxIoXInHI',
  sheetId: '19l3vRnuUOrk26eTK5o6oK1zT_Qv8EqaSx7kBWwNa-bQ',
  inboxFolderId: '1FEMxVWTEWwPbIES0WJt8hWfstPYPD-0w',

  // Always treated as staples (left out of "goes well with" suggestions),
  // on top of whatever Claude flags as a staple in each recipe.
  extraStaples: ['salt', 'black pepper', 'pepper', 'water', 'oil', 'olive oil', 'vegetable oil',
    'sunflower oil', 'butter', 'plain flour', 'flour', 'sugar', 'caster sugar']
};
