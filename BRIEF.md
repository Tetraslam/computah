# brief

## the product

computah is an improvements box: a small window inside your own app where you type what should change, and a coding agent you already have makes the change in the app's repo while you watch. it's for people building personal software with agents. they come to do one thing: say how the app should be different, and see it become that.

## the feeling

direct, handmade, yours. the box should feel like a tool that came with the machine and that you're allowed to open up, because the whole point is software its user can change.

## direction

retro os, narrowed to one program: hypercard on a 1-bit macintosh. the idea's ancestry is hypercard (the post that started this names it), and hypercard's own way of asking the machine for something was the message box: a small floating window with one field, sitting low on the screen. the improvements box is that window with an agent behind it.

this is studied, not themed. the box is a real floating window that drags, closes and remembers where it was. nothing is chrome for its own sake.

references and the principle taken from each:

- hypercard's message box: asking is a small, always-reachable window over your work, not a page or a modal.
- hypercard cards: content is set in a serif on plain white inside a ruled frame; controls are bold and few.
- system 7 windows: a state is shown by construction (stripes on the active title bar, a thick ring on the default button), not by color.

## primary sources

looked at before writing this (saved by the study in /tmp/study, original pixels):

- hypercard date book stack (wikipedia): a card is black line on white, hand-ruled, with serif dates and tiny icon buttons. take: thin black rules and a serif for the words that matter.
- "hypercard basics" intro card (archive.org emulation): a white card inside a double black rule on a 50% checker dither. take: the double rule as the frame of the window, and dither as the only gray.
- "hypercard menus" stack card: a serif title centered between two outlined arrow buttons, a bold bitmap heading, body text below a rule. take: the heading/rule/body order for each request.
- "your tour of hypercard" (hypercard 2.4): a white card with a hard black shadow on its right and bottom edges. take: a hard offset edge, never a blurred shadow.
- system 7.0 desktop (guidebookgallery): pinstriped title bars with the title knocked out in white, a square close box at the left, 1px black window borders, inverted black selection in menus. take: the title bar construction and inversion as the hover and selected state.
- system 7 calculator: a small utility window with rounded corners and a bold centered title. take: the proportions of a windoid that stays out of the way.

not obtained: a screenshot of the message box itself. the emulator booted but its input froze, so the message box is described from the surrounding sources, not from its own pixels.

## identity

- palette: black and white, only. no gray values and no accent color. the box sits on top of other people's apps, so it carries no color of its own to clash with theirs. emphasis is inversion (white on black).
- type: the request and the agent's answer are set in a serif stack (iowan old style, palatino, georgia), because they are the content, as on a card. labels and buttons use the system ui face in bold, standing in for chicago. no font files ship: the library must stay tiny and has no say over the host's fonts.
- shape: 1px black borders, square corners on the window, a 2px hard black edge on the right and bottom. buttons are rounded rectangles; the default button has the thick outer ring. density is compact: 12 to 13px text, 8px rhythm.
- texture: 1-bit dither patterns are the state language. a request waiting its turn shows a sparse dither, one being worked on shows a dither that marches, a finished one a solid mark, a failed one a cross, an undone one a hollow square. the title bar's stripes are the same material.
- motion: two movements, both stepped, never eased, as on the original machine. `zoom`: opening draws four outline rectangles from the launcher to the window in 160ms. `march`: the working dither shifts one pixel every 120ms. under reduced motion the window appears at once and the dither holds still.

## hierarchy

- the box: the field you type in comes first and is focused on open. then the newest request and what's happening to it. older requests recede below a rule. the agent's name and the hint are quiet.
- a request: your words first, in the serif. then one line of status with its mark. actions (stop, undo, steps) are text links at the end, visible but small.
- the demo page: one card that explains itself in a sentence and has a few live things on it to change. the box is the hero; the page is material for it.

## not parc

the closest of my projects is parc, because both have a surface that takes text from you.

- parc is warm paper with stepped off-whites and an ember accent; this is pure black and white with no gray and no accent.
- parc's field is a smooth webgpu dither shader that eases between energy levels; this uses fixed 1-bit css patterns that step.
- parc's composer opens in place inside the page and morphs its height on a curve; this is a separate window that floats over the app, drags, and opens with outline rectangles.
