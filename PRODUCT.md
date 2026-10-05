# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

About five people, all of whom add recipes to a shared Google Drive folder and use the site on phones and PCs. How they know each other is not recorded; don't assume "family".

They use it in three situations, all equally important:
- **Cooking from a phone** in the kitchen: following the steps, ticking off ingredients, keeping the screen on.
- **Choosing what to cook**: browsing or searching on phone or PC.
- **Finding a known recipe** by its name, book or author.

Adding recipes happens in Google Drive, not on the site. The site only shows whether each file has been processed.

## Product Purpose

The site replaces keyword searches across a Drive folder of recipe photos and PDFs with a private site where every recipe has the same layout. It shows:
- the dish photo;
- prep, cook and total time, with estimated times marked;
- servings;
- ingredients and steps that can be ticked off;
- a flowchart of which steps can happen at the same time;
- tips from the original;
- shared notes, signed by each person.

It works when someone can find a recipe quickly and cook from it on a phone without going back to the original file.

## Positioning

It is the group's own collection, photographed from their own cookbooks and recipe cards and added by them. It is not a public recipe site. Each recipe is read by Claude into a uniform structure, which makes three things possible:
- ingredient search with "goes well with" suggestions that leave out staples;
- a flowchart of steps that can run side by side;
- the same layout for every recipe, whatever the source looked like.

## Operating Context

- People drop PDFs, photos, Google Docs or Word files into the shared Drive folder. An hourly Apps Script job sends new or changed files to Claude Sonnet 5.5 and writes `recipes.json` and the dish photos to Drive.
- Visitors sign in with Google. The site reads recipes and photos from Drive, and reads and writes notes in a Google Sheet, using each visitor's own token.
- `?demo` shows sample data without signing in.

## Capabilities and Constraints

- **Stack:** plain HTML, CSS and JavaScript in `docs/`, with no build step, served by GitHub Pages. Mermaid draws the flowcharts.
- **Searches, all equally important:** free text (title, author, book, cuisine, ingredients), ingredients you have, and course.
- **The repository is public.** Recipe content (text, photos, extracted JSON) must never be committed. Access control comes from Drive sharing and the Google Cloud test-user list, not from a site password.
- **Recipe content is copyrighted.** Steps and tips are rewritten in Claude's own words, and the original file is linked for exact wording.
- **Dish photos vary.** Some recipes have a clean JPEG of the dish, some a crop from a photo of the page, and some only a picture of the first page. Some have no photo at all.
- **Collection size:** a few hundred recipes, growing.

## Brand Commitments

- Name: **Recipe book**. This replaces "Recipe Box", which is still in the code and README.
- The user asked for a name that suggests leafing through an old, well-used collection of recipes.

## Evidence on Hand

- Sample data: `docs/demo/recipes.json`.
- Six sample PDFs in `samples/` (gitignored). They are phone photos of cookbook pages: page 1 is the recipe, page 2 the dish photo.
- There are no testimonials, user counts or other proof, and none should be invented.

## Product Principles

1. **Cooking-first on the phone.** The recipe page must be easy to follow with messy hands at arm's length.
2. **One layout for every recipe,** however messy the source, so people always know where to look.
3. **Every way of finding a recipe is equal:** ingredients, name/book/author, or browsing.
4. **Private by construction.** Nothing about the recipes leaves Google, and nothing copyrighted goes into the repository.
5. **Honest about the source.** Mark estimated times and guesses, and always link the original.
