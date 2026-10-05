---
version: 2
slug: "docs-index-html"
primary_target: "docs/index.html"
related_targets: ["docs/app.js","docs/styles.css"]
---

# Recipe book site (docs/)

Scope: the whole site (home, recipe page, cooking mode, add-recipes page, sign-in). Mode: Operate.
Job: find a recipe (text, ingredients, course equally), choose what to cook, cook from a phone.
Constraints: plain HTML/CSS/JS, no build step; read-only users must not meet a note box that fails.

## Direction contract

THESIS: A clean, rounded recipe book in Moroccan clay colours. Soft shapes, plain photos, one friendly typeface. Refuses the clothbound look, heavy materials, gold foil, literary serif wordmarks and book-style photo frames.

OWN-WORLD: Sand ground (#f6efe6, dark #1e1612), terracotta accent (#b4502c), and six clay pigments as course colours: terracotta, ochre, mint, rose clay, majorelle blue, olive. Nunito is the only typeface. Wordmark "recipe book." is lowercase Nunito 900 with a terracotta dot. The diamond-and-dot pattern is kept behind the search panel, and recipes without a photo show it as a tile in their course pigment. Photos are shown plainly with rounded corners. Dark mode is warm brown-black with lifted pigments.

STORY: Visitors see their own shelf of recipes, filter it three ways, tap ingredients they lack to hide recipes that need them, open one and see times and servings at once, then start cooking step by step with a phone at arm's length.

FIRST VIEWPORT: Phone 390 wide. Home: sticky bar with the "recipe book." wordmark and an Add recipes link; the patterned search panel (search and ingredients); a sideways-scrolling row of round course swatches; the first rows of the two-column recipe grid, each card with a rounded photo or pigment tile, title, meta and key-ingredient pills. Recipe: pigment-tinted intro panel with title, byline, facts and the Start cooking pill above the fold.

FORM: Round pigment swatches scrolling sideways for courses; two-column card grid; key ingredients on each card with a tick, switched to a cross to mean "I don't have this", which hides recipes needing it. Cooking mode: one step per screen at poster size, a progress rail down the right edge, a Back/Next bar of two 64px pills. Motion: one damped ease-out, off under reduced motion.
