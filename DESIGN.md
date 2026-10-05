---
name: Recipe book
description: A well-used clothbound cookbook for a small group's own recipes, built for cooking from a phone.
colors:
  cloth: "#1f3a2b"
  cloth-navy: "#1d2b48"
  cloth-teal: "#17434a"
  cloth-plum: "#3f2345"
  cloth-tobacco: "#46301f"
  cloth-olive: "#3a3d1c"
  foil: "#e0bf55"
  on-cloth: "#eef0e6"
  on-cloth-soft: "#c9cfbf"
  ribbon: "#8a2232"
  ribbon-deep: "#6e1a27"
  on-ribbon: "#ffffff"
  page: "#f6f7f3"
  leaf: "#ffffff"
  ink: "#17211b"
  muted: "#55604f"
  rule: "#d6dbcf"
  rule-strong: "#b9c1b0"
  endpaper: "#dce4d2"
  endpaper-ink: "#1f3a2b"
  error: "#9b1c1c"
typography:
  display:
    fontFamily: "Young Serif, Iowan Old Style, Palatino Linotype, serif"
    fontSize: "clamp(2rem, 7vw, 3.1rem)"
    fontWeight: 400
    lineHeight: 1.08
  headline:
    fontFamily: "Young Serif, Iowan Old Style, Palatino Linotype, serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1
  title:
    fontFamily: "Young Serif, Iowan Old Style, Palatino Linotype, serif"
    fontSize: "1.15rem"
    fontWeight: 400
    lineHeight: 1
  cook:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "clamp(1.8rem, 7.8vw, 3rem)"
    fontWeight: 500
    lineHeight: 1.22
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tnum"
  body-strong:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.3
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif"
    fontSize: "0.74rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.06em"
rounded:
  working: "2px"
  spine-small: "1px 3px 3px 1px"
  spine-card: "2px 5px 5px 2px"
  spine-cover: "2px 6px 6px 2px"
  spine-book: "3px 8px 8px 3px"
  tab: "6px 6px 0 0"
  tab-side: "0 6px 6px 0"
spacing:
  gutter: "16px"
  tab-gap: "4px"
  section: "2.2rem"
  grid-gap: "1.6rem 1.2rem"
  grid-gap-phone: "1.2rem 0.8rem"
components:
  ribbon:
    backgroundColor: "{colors.ribbon}"
    textColor: "{colors.on-ribbon}"
    padding: "0.7rem 2.1rem 0.7rem 1.1rem"
    height: "48px"
  button-cloth:
    backgroundColor: "{colors.cloth}"
    textColor: "{colors.on-cloth}"
    rounded: "{rounded.working}"
    padding: "0.6rem 1.2rem"
    height: "44px"
  button-plate:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.ink}"
    rounded: "{rounded.working}"
    padding: "0.8rem 1.4rem"
    height: "48px"
  cook-next:
    backgroundColor: "{colors.ribbon}"
    textColor: "{colors.on-ribbon}"
    rounded: "{rounded.working}"
    height: "64px"
  cook-next-hover:
    backgroundColor: "{colors.ribbon-deep}"
  cook-prev:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.working}"
    height: "64px"
  label-chip:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.working}"
    padding: "0.25em 0.7em"
    height: "34px"
  label-chip-on:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.page}"
  tab:
    backgroundColor: "{colors.cloth}"
    textColor: "{colors.on-cloth-soft}"
    rounded: "{rounded.tab}"
    padding: "0.45rem 1.6rem 0.4rem 1rem"
    height: "40px"
  tab-on:
    textColor: "{colors.on-cloth}"
  input:
    backgroundColor: "{colors.page}"
    textColor: "{colors.ink}"
    rounded: "{rounded.working}"
    padding: "0.55em 0.75em"
    height: "44px"
  spine-label:
    backgroundColor: "{colors.cloth}"
    textColor: "{colors.on-cloth}"
    typography: "{typography.title}"
    rounded: "{rounded.spine-small}"
    padding: "0.5rem 0.9rem 0.45rem"
  slip:
    backgroundColor: "{colors.leaf}"
    textColor: "{colors.ink}"
    padding: "0.9rem 1.1rem"
---

# Design System: Recipe book

## Overview

**Creative North Star: "The well-used clothbound cookbook"**

Every screen is part of one cloth-bound book. Saturated bookcloth with a fine woven texture frames the screen: the top bar is the spine, each recipe has a cover, and section names are small cloth spine labels. Names are stamped on the cloth in Young Serif, in gold foil when they are large enough and blind-stamped (pale, no gold) when they are not. The pages between the covers are a cool near-white with green-black ink, set entirely in the system sans with tabular figures. A printed two-colour endpaper sits behind the search box, and thumb-index tabs, one cloth per course, file the collection.

One oxblood silk ribbon marks where you are. It hangs from the tab you are on, sits in the page at the step you reached, is the button that starts or resumes cooking, slides down the right edge of cooking mode, and is the Next button there. Cooking mode itself drops the book furniture down to a cloth bar and puts one step on the page at poster size, readable at arm's length.

The system rejects the cream-page, serif-everywhere recipe blog and the white photo-grid recipe site. Photos are never tinted or cropped into tiles: they are tipped-in plates in a thin white mount.

**Key Characteristics:**
- Bookcloth (woven texture over a saturated field) frames every screen; course cloths colour each recipe.
- Young Serif appears only on cloth; everything on the page is system sans with tabular figures.
- Gold foil only at 24px and up; smaller stamped text is pale.
- The oxblood ribbon means "you are here" and nothing else of substance.
- Done things are struck through with a solid ink bar, never greyed out.
- Photos are plates pasted in whole, with a white mount and a lift shadow.

## Colors

Deep, saturated bookcloths and a single oxblood ribbon over a cool near-white page with green-black ink.

### Primary
- **Bottle green bookcloth** (cloth): the lead cloth. Top bar, cooking-mode bar on the default course, the "All" tab, the cloth button, spine labels on pages without a course, the 3px cloth edge under the tab rows and along the desktop index, the drawer's top edge, the status table head. Also the browser theme colour.
- **Gold foil** (foil): stamped names on cloth at 24px and up only: the "Recipe book" brand, cover titles on the recipe page and sign-in, and card titles on photo-less covers once the card is 230px wide or more. Hover colour for links on cloth.

### Secondary
- **Course cloths**: navy (cloth-navy), teal (cloth-teal), plum (cloth-plum), tobacco (cloth-tobacco) and olive (cloth-olive). Each course is bound in one of these, by a fixed course map (mains and dinners navy; lunches, starters, soups and drinks teal; desserts and preserves plum; baking, bread, cakes and breakfasts tobacco; sides, salads, sauces and snacks olive), with unknown courses hashed onto one of the five. A recipe's cloth carries through its card, cover, spine labels, step numbers, method tabs and cooking-mode bar. The direction listed oxblood among the course cloths; the build keeps oxblood for the ribbon only, and the build wins.

### Tertiary
- **Oxblood ribbon** (ribbon), deepening to **ribbon-deep** on hover, with white text (on-ribbon). See the Ribbon Rule.

### Neutral
- **On-cloth** (on-cloth): text and icons on cloth: nav links, byline links, active tab labels, spine labels, step numbers, the cooking-mode bar title, the times and servings figures.
- **On-cloth soft** (on-cloth-soft): secondary text on cloth: inactive tab labels, the byline, the fact labels, the "est." mark, and blind-stamped card titles under 230px.
- **Page** (page): the cool near-white ground; also the fill of inputs, chips and the cooking-mode Back button.
- **Leaf** (leaf): white surfaces lifted from the page: the bookplate, slips, the cooking-mode nav bar and drawer, photo mounts, the status table.
- **Ink** (ink): green-black body text; fill of ticked boxes and selected chips; the strike-through bar.
- **Muted** (muted): metadata, field labels, counts, step times, ingredient group names.
- **Rule / rule strong** (rule, rule-strong): hairlines between list rows (rule); input, chip, tick-box and plate outlines and the cooking-mode rail (rule-strong).
- **Endpaper / endpaper ink** (endpaper, endpaper-ink): the printed endpaper behind the search box, a 32px diamond-and-dot repeat in endpaper ink at half opacity. Endpaper also backs inline code.
- **Error** (error): failed processing status and form errors on the page.

**Dark mode** (prefers-color-scheme: dark) re-inks the page, not the cloth: cloth #1d3628, page #121813, leaf #1a221c, ink #e8ebe2, muted #a2ac9c, rule #2b352e, rule strong #3d4a40, ribbon #a8344a, ribbon deep #8a2232, endpaper #18211b, endpaper ink #6f9a7e, error #ff9a9a. Foil, on-cloth, on-cloth soft and the five course cloths are the same in both themes.

### Named Rules
**The Ribbon Rule.** Oxblood marks where you are and where your focus is. It appears as the bookmark hanging from the active tab (course index and Steps/Flowchart alike), the ribbon left at the current step, the Start cooking / Carry on cooking ribbon, the cooking-mode rail mark and the Next button; and, as the focus and pointer colour, the focus ring, text caret, selection, link hover underline and the keep-awake checkbox. It is never a course cloth, a heading colour or decoration.

**The Cloth Carries the Course Rule.** A recipe takes one cloth from the course map and uses it everywhere that recipe is bound: card, cover, spine labels, step numbers, method tabs, cooking-mode bar. Never mix two course cloths in one recipe.

## Typography

**Display Font:** Young Serif (with Iowan Old Style, Palatino Linotype, serif), loaded from the Google Fonts CDN.
**Body Font:** the system sans (system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif) with tabular figures throughout.

**Character:** Young Serif is the foil stamp: soft, heavy, bookish, used only on cloth. The system sans does all the reading and operating, so recipes read like a clean printed page and the numbers line up.

### Hierarchy
- **Display** (Young Serif 400, clamp(2rem, 7vw, 3.1rem), 1.08): recipe and Add recipes cover titles, in foil. The sign-in cover title runs larger, clamp(2.6rem, 11vw, 3.6rem) at line height 1.
- **Headline** (Young Serif 400, 1.5rem, 1): the "Recipe book" brand in foil; card titles stamped on photo-less covers at 230px and wider, in foil.
- **Title** (Young Serif 400, 1.1 to 1.15rem): spine labels (1.15rem) and the Steps/Flowchart tabs (1.1rem), in on-cloth colours; the cooking-mode bar title (1.1rem) and step numbers (1rem), also on-cloth. Blind-stamped card titles below 230px use clamp(1rem, 9.5cqi, 1.4rem) in on-cloth soft.
- **Cook** (system sans 500, poster size, letter-spacing -0.01em): the single step in cooking mode, in three sizes by step length. Steps over 140 characters use the base size clamp(1.8rem, 7.8vw, 3rem) at 1.22; steps of 71 to 140 characters use clamp(2.1rem, 9.2vw, 3.5rem) at 1.16; steps of 70 characters or fewer use clamp(2.5rem, 11vw, 4.2rem) at 1.12. The "Step 1 of 5" line sits above at 1.25rem/750 and 1rem/600 muted.
- **Body** (system sans 400, 16px, 1.55, tabular figures): ingredients, steps, tips and notes, held to 60 to 70ch.
- **Body strong** (system sans 650, 1rem, 1.3): card titles under the cover, buttons, ingredient quantities. Fact figures on the cover are 1.12rem/650.
- **Label** (system sans, 0.74rem, letter-spacing 0.06em, uppercase): the Prep / Cook / Total / Serves labels and status table headings. Ingredient group names use 0.78rem/700 uppercase muted; field labels use 0.78rem/650 muted, sentence case.

### Named Rules
**The Stamped-on-Cloth Rule.** Young Serif appears only on cloth. Headings on the page ground, the cooking-mode step, the drawer heading and the end-of-recipe heading are system sans at 500 to 750.

**The Foil Floor Rule.** Gold foil only at 24px and up. Smaller stamped text on cloth is on-cloth or on-cloth soft: spine labels, tabs, step numbers, the cooking-mode bar title and the "est." mark are never gold. Card titles switch from blind stamp to foil through a container query at 230px card width.

## Layout

A single centred column up to 1180px with a 16px gutter (respecting the safe area), the top bar sticky above it. Home is a full-bleed endpaper band holding the bookplate (search and ingredient fields, max 760px, two columns from 700px), then the thumb index, then the shelf of covers.

The shelf is an auto-fill grid of covers at least 210px wide (gaps 1.6rem by 1.2rem); at 520px and below it is fixed at two columns (gaps 1.2rem by 0.8rem). Covers are 4:3.3.

The thumb index is a horizontal, scrollable strip of tabs with a 4px gap sitting on a 3px cloth edge; inactive tabs drop 6px, so the active tab stands proud. From 1000px it moves to the right of the shelf as a sticky vertical index (top 76px) hanging from a 3px cloth edge, tabs at least 7.5rem wide, with no stagger.

The recipe page puts the cover first; from 900px a dish plate sits beside it (1.35fr to 1fr). From 860px ingredients become a sticky left column (minimum 250px, 1fr) beside the method (1.9fr) with a 3rem gap. Sections start with a spine label 2.2rem below the previous section.

Cooking mode is a full-screen three-row grid: the cloth bar (56px minimum), one step per page (max 42rem, padded clamp(1.2rem, 5vw, 3rem) with room on the right for the ribbon rail), and a two-button nav bar (Back 1fr, Next 1.6fr) that respects the bottom safe area. Ingredients open as a drawer from the bottom, up to 75% high.

## Elevation & Depth

The book is physical, so objects lift off the page with one soft house shadow, the lift: bookplate, covers, recipe cover, plate photos, the cloth button, the flowchart detail panel and the status table. Within cloth, depth is pressed in rather than raised: a blind-stamped inset frame, an inset fold at the foot of inactive tabs, and a darkened spine edge on the left of each card cover. Slips sit lower than lifted objects, with a lighter shadow. Hover raises a card cover by 3px with a deeper shadow.

### Shadow Vocabulary
- **Lift** (`box-shadow: 0 1px 2px rgb(23 33 27 / .14), 0 6px 18px -6px rgb(23 33 27 / .22)`; dark: `0 1px 2px rgb(0 0 0 / .4), 0 8px 20px -8px rgb(0 0 0 / .6)`): anything bound or pasted that sits on the page.
- **Cover hover** (`box-shadow: 0 2px 3px rgb(23 33 27 / .16), 0 14px 26px -10px rgb(23 33 27 / .35)`): a card cover lifted on hover, with a 3px rise.
- **Slip** (`box-shadow: 0 1px 1px rgb(23 33 27 / .08), 0 3px 10px -4px rgb(23 33 27 / .18)`): tipped-in tips and notes.
- **Mounted photo** (`box-shadow: 0 1px 2px rgb(0 0 0 / .4), 0 4px 10px -2px rgb(0 0 0 / .45)`): a photo pasted onto a cover.
- **Tab fold** (`box-shadow: inset 0 -10px 10px -8px rgb(0 0 0 / .45)`; desktop `inset 10px 0 10px -8px`): inactive tabs tucked behind the page edge.
- **Drawer** (`box-shadow: 0 -12px 30px -12px rgb(0 0 0 / .35)`): the ingredients drawer in cooking mode.

### Named Rules
**The Pressed, Not Raised, Rule.** Detail inside cloth is pressed in (frames, folds, spine edge); only whole objects lift off the page.

## Shapes

Nearly square. The working radius is 2px on inputs, buttons, chips, tick boxes and tags. Bound objects have a spine: a tighter radius on the left than on the right (cards 2px/5px, recipe cover 2px/6px, sign-in cover 3px/8px, spine labels and step numbers 1px/3px). Tabs are rounded only on the edge that sticks out (6px top corners; 6px right corners on the desktop index). The ribbon has a swallowtail cut: the Start cooking ribbon notches 14px into its right end, and the bookmarks on tabs and steps and the cooking-mode rail mark notch into their lower end. The only circles are the 7px dots on the cooking-mode rail. Blind-stamped frames are a 1px dark line inset 7 to 9px from the cloth edge (15px on the spine side of cards). The bookplate has a double rule inset 8px.

## Components

### Buttons
Bound and pressed, never pill-shaped.
- **Ribbon (start or carry on cooking):** oxblood with a faint silk sheen, white 650-weight text with the ribbon icon, 48px tall, swallowtail right end, bled off the left edge of the cover. Hover slides it 4px right; focus shows a 2px white inset ring.
- **Cloth button:** bottle green cloth, on-cloth text, 44px, 2px radius, the lift shadow; hover brightens it (brightness 1.18); disabled at 55% opacity. Same in both themes.
- **Plate button (sign-in):** white leaf on the cloth cover, ink text, 48px, a hairline drop and an inner rule 5px in, which turns oxblood on hover.
- **Cooking-mode Next / Back:** 64px tall, 1.15rem/650. Next is oxblood (deep oxblood on hover); Back is page-coloured with a 1.5px strong rule, at 40% when disabled.
- **Icon buttons:** 48px square, transparent on cloth, on-cloth icons; hover tints white at 8%.

### Chips
- **Style:** square-cornered labels (2px), page fill, strong rule border, 34px tall, 0.88rem; a count in small muted text.
- **State:** hover darkens the border to ink; selected ingredients are filled ink with page-coloured text and a close icon.

### Cards / Containers
- **Covers:** each card is a cloth cover (4:3.3) in its course cloth, with the spine edge, the lift shadow and the spine radius. A dish photo is pasted on whole in a 3px white mount; a picture of the recipe page fills the cover from the top. A cover without a photo shows the full title stamped on the cloth, centred inside a blind-stamped frame (up to four lines). Title and metadata sit below the cover, not on it.
- **Bookplate:** white leaf, 1px strong rule plus a double rule inset 8px, the lift shadow.
- **Slips:** white leaf, 1px rule border, slip shadow, 0.9rem by 1.1rem padding, text held to 70ch. Notes are signed in muted small text.

### Inputs / Fields
- **Style:** page fill, 1px strong rule, 2px radius, 44px tall; a small 650-weight muted label above. Textareas use leaf fill in the notes form.
- **Focus:** a 2px oxblood outline.
- **Tick boxes:** drawn squares (1.2rem, 1.5px strong rule) that fill with ink and show a page-coloured tick, scaled in with the house ease. Ticked lines are struck through with a 2px ink bar.

### Navigation
- **Top bar (spine):** sticky bottle green cloth, 52px minimum, foil brand at left, small on-cloth links at right that turn foil on hover. Hidden in cooking mode.
- **Thumb index and method tabs:** cloth tabs in the course's cloth, 40px minimum, 0.9rem/600 (method tabs in Young Serif 1.1rem), on-cloth soft at rest, on-cloth when active. The active tab carries the ribbon bookmark (9px by 18px, oxblood, notched) hanging from its top right. Course tabs sit on a 3px cloth edge; see Layout for the desktop index.

### Spine labels
Section headings on the recipe and Add recipes pages are small cloth labels in the recipe's cloth: Young Serif 1.15rem in on-cloth, spine radius, no foil.

### Cooking mode
One step per screen at poster size (see Typography), a muted time line, and a 52px "Mark done" toggle whose box fills with ink. A done step is struck through with a 3px ink bar. On the right edge a thin rail of 7px dots (ink when done) carries the ribbon mark, which slides down to the current step with one damped ease-out slide (0.55s). The ingredients drawer slides up from the bottom with a 3px cloth top edge and larger ticks (1.15rem text, 1.45rem boxes).

## Do's and Don'ts

### Do:
- **Do** frame screens and recipe identity with bookcloth: the woven texture over the cloth colour, always together.
- **Do** bind each recipe in its course cloth and carry that cloth through cover, spine labels, step numbers, tabs and the cooking-mode bar.
- **Do** keep oxblood for where you are and where your focus is: active-tab bookmark, current step, start or carry on cooking, the cooking-mode rail mark, the Next button, focus and selection.
- **Do** use gold foil only at 24px and up; below that, stamp in on-cloth or on-cloth soft.
- **Do** strike done ingredients and steps through with a solid ink bar (2px on the page, 3px in cooking mode).
- **Do** paste photos in whole, in a white mount with a shadow, and give photo-less recipes a cloth cover with the title stamped.
- **Do** size cooking-mode step text by step length, using the three poster sizes.
- **Do** use the house ease (cubic-bezier(.16, 1, .3, 1)) for slides and lifts, and zero all motion under reduced motion.

### Don't:
- **Don't** set Young Serif on the page ground; on the page, everything is system sans.
- **Don't** use oxblood as a course cloth, a heading colour or decoration.
- **Don't** grey out done items; strike them through.
- **Don't** tint, filter or crop photos into uniform tiles.
- **Don't** round corners beyond the spine radii; no pills.
- **Don't** build the cream-page, serif-everywhere recipe blog or the white photo-grid recipe site.

## Raster provenance

The site ships no raster images. Its only image assets are inline SVG written in the build: the favicon and the endpaper repeat (both data URIs) and the icon symbols in the page. Dish and page photos load at runtime from each signed-in user's Google Drive and are never committed. The demo data (`docs/demo/recipes.json`) has no photos. Young Serif is loaded from the Google Fonts CDN, not self-hosted.
