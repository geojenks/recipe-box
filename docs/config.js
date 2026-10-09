// Site settings. None of these are secrets: the web app checks the shared
// password (script property SITE_PASSWORD) before it does anything.
window.RECIPE_BOX_CONFIG = {
  // Apps Script > Deploy > Manage deployments: the web app's address, ending /exec
  serviceUrl: 'https://script.google.com/macros/s/AKfycbx8ycD7dTkO45JwXzWaHXQErmfsd0uxPp4CbIUK_DPUHSszsQ3KAdUoJ_B8OhAU87eenA/exec',

  // Logged by setup() in the Apps Script editor. Only used to link to the shared folder.
  inboxFolderId: '1FEMxVWTEWwPbIES0WJt8hWfstPYPD-0w',

  // Always treated as staples (left out of "goes well with" suggestions),
  // on top of whatever Claude flags as a staple in each recipe.
  extraStaples: ['salt', 'black pepper', 'pepper', 'water', 'oil', 'olive oil', 'vegetable oil',
    'sunflower oil', 'butter', 'plain flour', 'flour', 'sugar', 'caster sugar']
};
