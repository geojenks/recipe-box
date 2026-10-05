---
name: Recipe book
description: A clean, rounded recipe book in Moroccan clay colours, built for choosing and cooking from a phone.
colors:
  sand-ground: "#f6efe6"
  sand-surface: "#fffaf4"
  clay-ink: "#3b2a21"
  clay-muted: "#74594a"
  sand-rule: "#e8d9c8"
  sand-rule-strong: "#cfb59d"
  pattern-ground: "#efd9c3"
  terracotta-accent: "#b4502c"
  terracotta-deep: "#963f20"
  on-accent: "#ffffff"
  majorelle-link: "#2f4fa3"
  have-green: "#3f6b4e"
  error-red: "#a3261b"
  pigment-terracotta: "#b8532f"
  pigment-ochre: "#d49a37"
  pigment-mint: "#7ea488"
  pigment-rose-clay: "#d6a196"
  pigment-majorelle: "#2f4fa3"
  pigment-olive: "#8c8a4a"
typography:
  wordmark:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2.6rem, 12vw, 3.4rem)"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "-0.03em"
  display:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(2rem, 7.5vw, 3.2rem)"
    fontWeight: 900
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.35rem"
    fontWeight: 850
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 850
    lineHeight: 1.25
  body:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.55
  label:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "0.84rem"
    fontWeight: 800
    lineHeight: 1.4
  cook:
    fontFamily: "Nunito, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(1.8rem, 7.8vw, 3rem)"
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: "-0.01em"
rounded:
  sm: "6px"
  md: "16px"
  card: "18px"
  panel: "24px"
  cover: "26px"
  pill: "999px"
spacing:
  xs: "6px"
  sm: "10px"
  md: "16px"
  lg: "1.8rem"
components:
  button-primary:
    backgroundColor: "{colors.terracotta-accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    padding: ".6rem 1.25rem"
    height: "46px"
  button-primary-hover:
    backgroundColor: "{colors.terracotta-deep}"
  button-secondary:
    backgroundColor: "{colors.sand-surface}"
    textColor: "{colors.clay-ink}"
    rounded: "{rounded.pill}"
    padding: ".6rem 1.25rem"
    height: "46px"
  chip:
    backgroundColor: "{colors.sand-surface}"
    textColor: "{colors.clay-ink}"
    rounded: "{rounded.pill}"
    padding: ".2rem .8rem"
    height: "36px"
  key-ingredient:
    backgroundColor: "{colors.sand-surface}"
    textColor: "{colors.clay-ink}"
    rounded: "{rounded.pill}"
    padding: ".15rem .6rem .15rem .45rem"
    height: "32px"
  search-field:
    backgroundColor: "{colors.sand-surface}"
    textColor: "{colors.clay-ink}"
    rounded: "{rounded.md}"
    height: "48px"
  recipe-thumb:
    rounded: "{rounded.card}"
  cook-next:
    backgroundColor: "{colors.terracotta-accent}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.pill}"
    height: "64px"
---

# Design System: Recipe book

## Overview

**Creative North Star: "The Clay Kitchen Shelf"**

A clean, soft, rounded book in the colours of Moroccan clay: a sand ground, terracotta for the one accent, and six clay pigments (ochre, mint, rose clay, majorelle blue, olive, terracotta) that colour the courses. Nunito is the only typeface, heavy (850 to 900) for names and calm (500 to 650) for reading. Photos are shown plainly, with rounded corners and nothing else around them. Courses are filtered by round pigment swatches that scroll sideways, and recipes sit in a two-column grid on a phone.

The diamond-and-dot pattern stays, but in one place: behind the search panel (and the sign-in screen and the Add recipes header). Recipes without a photo wear the same pattern as a tile in their course pigment. Everything else is flat sand, with soft rounded shapes and a single soft shadow for things that lift.

Confirmed rejections: the clothbound look, heavy materials, gold foil, literary serif wordmarks, book-style photo frames.

**Key Characteristics:**
- One typeface, Nunito, in light and dark modes alike.
- Lowercase wordmark "recipe book." in 900 weight with a terracotta full stop.
- Six course pigments; a recipe keeps one pigment across card, intro panel, step numbers and cooking bar.
- Everything interactive is a pill or a rounded rectangle; ticks and crosses mark ingredient state.
- Dark mode is a warm brown-black with lifted pigments, not an inversion.

## Colors

Warm sand and clay neutrals, one terracotta accent, six pigments used as course identity.

### Primary
- **Terracotta** (`terracotta-accent`, dark #e0784f): primary buttons, the wordmark full stop, caret, selection, input focus border, the cooking-mode rail mark and Next button, dashed "lacking" outlines.
- **Deep Terracotta** (`terracotta-deep`, dark #ea8c66): hover of primary, and the "Needs ..." line on a card.

### Secondary (course pigments)
- **Terracotta, Ochre, Mint, Rose Clay, Majorelle Blue, Olive** (`pigment-*`, dark variants #d36a43, #dca64a, #8fb79a, #dcab9f, #6f8ad6, #aaa765): one per course, assigned in app.js (main/dinner terracotta; baking/breakfast/brunch ochre; side/salad/vegetable mint; dessert/pudding rose clay; lunch/starter/soup/drink majorelle; sauce/snack/preserve olive; unknown courses by hash). Used as swatch discs, photo-less tiles, a 22% tint of the surface (`pg-soft`) behind the recipe intro, cooking bar and step numbers, and the section-title dot.

### Neutral
- **Sand Ground** (#f6efe6, dark #1e1612): page. **Sand Surface** (#fffaf4, dark #2a201a): fields, chips, slips, nav bar.
- **Clay Ink** (#3b2a21, dark #f2e6da): text, ticked boxes, active states. **Clay Muted** (#74594a, dark #c2a998): secondary text.
- **Sand Rule** (#e8d9c8) and **Sand Rule Strong** (#cfb59d): hairlines and control borders. **Pattern Ground** (#efd9c3, dark #33251d): behind the diamond pattern.
- **Majorelle** (`majorelle-link`, dark link #a9bbf0, focus #8ea6ea): links and focus rings. **Have Green** (#3f6b4e) the tick on a key ingredient. **Error Red** (#a3261b).

### Named Rules
**The Pigment Per Course Rule.** A recipe takes one pigment from its course and carries it through its card tile, intro panel, step numbers, section dots and cooking bar. Never mix two.
**The One Accent Rule.** Terracotta is the action and focus colour. A course pigment is identity, never a button.

## Typography

**Display, Body and Label Font:** Nunito (Google Fonts, 400 to 900, with system-ui fallback). Nunito is the only typeface; nothing is set in a serif or a second family.

**Character:** Round, friendly and sturdy. Weight does the hierarchy work. Tabular figures throughout, so times and quantities line up.

### Hierarchy
- **Wordmark** (900, clamp(2.6rem, 12vw, 3.4rem) on sign-in, 1.45rem in the top bar, -0.03em, lowercase): "recipe book." with a terracotta full stop.
- **Display** (900, clamp(2rem, 7.5vw, 3.2rem), 1.05): recipe title, Add recipes heading.
- **Headline** (850, 1.35rem): section titles, led by a small pigment dot.
- **Title** (850, 1.02rem, 1.25): card titles.
- **Body** (500, 16px, 1.55; text blocks 60 to 70ch): reading text.
- **Label** (750 to 850, .8 to .9rem, sentence case): meta lines, fact labels, chips, keys, swatch names.
- **Cook** (700, clamp(1.8rem, 7.8vw, 3rem); `mid` for 71 to 140 characters clamp(2.1rem, 9.2vw, 3.5rem); `short` for 70 or fewer clamp(2.5rem, 11vw, 4.2rem)): one step per screen, readable at arm's length.

### Named Rules
**The One Face Rule.** Nunito only, in every mode and on every surface.
**The Lowercase Wordmark Rule.** The name is lowercase with a terracotta dot; everything else is sentence case.

## Layout

Single column on a phone with 16px side padding; `main` is capped at 1180px. Home runs top to bottom: a sticky 56px top bar, the search panel (max 780px, two columns from 700px), the swatch row, a result count, then the recipe grid. The grid is `auto-fill` at 220px minimum and two columns up to 520px wide, with 1.4 to 1.8rem row gaps. The swatch row scrolls sideways with proximity snapping and centres from 812px. The recipe page stacks intro then photo, goes side by side from 900px when a dish photo exists, and puts ingredients in a sticky left column with steps on the right from 860px. Cooking mode is a full-screen fixed grid: bar, step page, nav bar, with step content max 42rem. Rhythm is small even steps (6, 10, 14, 16px) inside controls and 1.2 to 2.4rem between sections.

## Elevation & Depth

Mostly flat tonal layering: sand ground, lighter surface for fields and slips, hairline rules. One soft shadow vocabulary for things that lift or float.

### Shadow Vocabulary
- **Lift** (`0 1px 2px rgb(59 42 33 / .08), 0 8px 22px -10px rgb(59 42 33 / .3)`; dark `0 1px 2px rgb(0 0 0 / .4), 0 10px 24px -10px rgb(0 0 0 / .7)`): card photo on hover (also rises 3px), suggestion panel, toast, sign-in card, flow detail.
- **Field** (`0 1px 2px rgb(59 42 33 / .08)`): search inputs on the pattern.
- **Drawer** (`0 -12px 30px -12px rgb(0 0 0 / .35)`): cooking-mode ingredients drawer.

### Named Rules
**The Flat At Rest Rule.** Cards and photos carry no shadow until hovered.

## Shapes

Soft and rounded everywhere. Photos and tiles 18px, the recipe intro and photo 26px, the search panel 24px, the sign-in card 28px, fields 16px, tick boxes 7px, and every button, chip, key and swatch a full pill or circle. Photos are shown whole-bleed in their rounded rectangle with `object-fit: cover`, with no frame, mount or border. The diamond tile is 32px, drawn in terracotta, ochre and majorelle on pattern ground; as a one-colour mask it is painted in the course pigment at 60% over a 22% pigment tint, offset per recipe so neighbours do not line up.

## Components

### Buttons
- **Shape:** pill (999px), 46px high, 800 weight.
- **Primary:** terracotta fill, white text (dark mode: dark ground text); hover deepens to terracotta-deep; press scales to .97.
- **Secondary:** sand surface with a 1.5px strong rule border; hover darkens the border to ink. The notes "Add note" button is ink-filled.
- **Link buttons** are majorelle, 750 weight, underlined.

### Wordmark and top bar
Sticky sand bar, 56px, a hairline beneath. Wordmark left, majorelle nav links right. Hidden in cooking mode.

### Course swatches
Round 50px pigment discs with a 14px gap and the course name below, scrolled sideways. "All" is a four-pigment conic disc. Selected: a 3px ground ring then a 2.5px ink ring and ink label; hover scales 1.06; focus uses the focus colour for the ring.

### Recipe card
Rounded 5:4 thumb (photo, or the pigment pattern tile), bold title, muted meta line "time · serves n". A recipe needing something you lack gets a "Needs ..." line in deep terracotta and a dimmed greyscale thumb.

### Key ingredients
Pill buttons under each card, 32px, with a green tick. Tapping marks "I don't have this": the pill turns dashed terracotta, the name is struck through and the icon becomes a cross. Recipes needing it move to a "hidden" list that can be shown.

### Search panel and chips
The panel is a 24px-rounded block of the diamond pattern holding a search field and an ingredient field (48px, 16px radius, leading line icon, terracotta border on focus), chips and a "Goes well with" suggestion panel. Chips are pills: ink-filled with a tick for "have", dashed terracotta for "No ...".

### Recipe page
A pigment-tinted 26px intro panel (title, byline, lede, facts as label over bold value, primary "Start cooking" pill), the dish photo beside it, tag pills, a two-column ingredients and method layout. Ticks are 1.3rem rounded boxes filled with ink; ticked lines are struck through, not faded. Steps carry a pigment-ringed number disc; the step reached in cooking mode gets a terracotta ring. Steps and Flowchart is a two-part pill toggle. Tips and notes sit on rounded surface slips.

### Cooking mode
Full screen. A pigment-tinted bar with close, title and Ingredients button. One step per screen at the Cook size, with "Step n of N", optional time, and a "Mark done" pill that fills the circle with ink and strikes the text (3px). A progress rail on the right edge: a hairline with a dot per step, a terracotta bar filled down to the current step ending in a ringed terracotta dot. A bottom bar of two 64px pills: Back (outlined) and Next (terracotta, 1.6 times wider). The ingredients drawer slides up with 24px top corners.

## Do's and Don'ts

### Do:
- **Do** set every piece of text in Nunito; use weight (500, 650, 800, 900) for hierarchy.
- **Do** give each recipe a single course pigment and show it as a swatch, a tile, a tint and a number ring.
- **Do** keep the diamond pattern to the search panel, the sign-in screen, the Add recipes header and photo-less tiles.
- **Do** show photos plainly with rounded corners and no frame.
- **Do** mark done and lacking by strike-through and a dashed or ink fill, with the tick or cross, not by fading alone.
- **Do** keep touch targets at least 32px (keys), 46px (buttons), 64px (cooking Back/Next), and honour `prefers-reduced-motion`.
- **Do** use the one ease, `cubic-bezier(.16, 1, .3, 1)`, for lifts and slides.

### Don't:
- **Don't** bring back the clothbound look: no woven textures, gold foil, ribbons, blind-stamped frames or spine labels.
- **Don't** use a serif or a literary wordmark.
- **Don't** frame or mount photos like a book plate.
- **Don't** use a course pigment as a button colour, or terracotta as a course.
- **Don't** add hard shadows, uppercase eyebrow labels or kickers.
