---
version: 1
slug: "docs-index-html"
primary_target: "docs/index.html"
related_targets: ["docs/app.js","docs/styles.css"]
---

# Recipe book site (docs/)

Scope: the whole site (home, recipe page, cooking mode, add-recipes page). Mode: Operate.
Job: find a recipe (text, ingredients, course equally), choose what to cook, cook from a phone.
Constraints: plain HTML/CSS/JS, no build step; read-only users must not meet a note box that fails.

## Direction contract

THESIS: A well-used clothbound cookbook, not a recipe website. Bookcloth frames every screen, foil stamping names things, thumb-index tabs file the courses, and a silk ribbon marks where you are. Refuses the cream-page, serif-everywhere recipe blog and the white photo-grid recipe site.

OWN-WORLD: Saturated bookcloth fields (bottle green lead; oxblood, navy, teal, plum as course cloths) with a fine woven texture; gold foil only at 24px and up; a printed two-colour endpaper repeat; page ground is a cool near-white (#f6f7f3, translated from the card's cream chip), ink a green-black. Young Serif only as foil stamping on cloth (brand, cover titles); all body and UI in the system sans with tabular figures. Oxblood ribbon is reserved for "where you are": active tab, current step, start cooking. No-photo recipes get a cloth cover with the title stamped; photos are tipped-in plates with a thin mount, never tinted.

STORY: Visitors see their own shelf of recipes, filter it three ways, open one and see times and servings at once, then pull the ribbon to cook step by step with a phone at arm's length.

FIRST VIEWPORT: Phone 390 wide. Home: compact green cloth band with "Recipe book" foil-stamped and two small pale links; endpaper strip; search box and ingredient box; course thumb-index tabs; the first row of the two-column recipe grid visible. Recipe: cloth cover band in the course colour with title stamped, byline, prep/cook/total/serves row, and the ribbon "Start cooking" button, all above the fold.

FORM: The clothbound cookbook, my top-ranked grounded candidate (1 of 7), chosen by the user as the pick card; seed key c76c4d30. Raises kept for cooking mode: one step per full screen (from the vertical feed); step text at poster size, readable at arm's length (from metro tiles); done steps struck through with a bar, not greyed (from the centre-rail edition). Signature interaction: the ribbon. Pulling it opens cooking mode; the ribbon tab then slides down the edge to mark the current step as you swipe or tap next. Motion: one damped slide, ease-out, off under reduced motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
