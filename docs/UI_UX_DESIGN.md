# VIEWER — UI/UX Design Spec

**Design language:** *Night Instrument*
**Scope:** Release 1, web portal and desktop EXE (identical)
**Companion:** [Implementation plan](./IMPLEMENTATION_PLAN.md)

---

## 1. The idea

Most 3D viewers look like a CAD program or a game launcher. VIEWER should feel like a **precision instrument used in a dark operations room**: the model is the only bright thing on screen, the interface is quiet glass around it, and every number it shows is something you can trust, copy and act on.

Three words guide every decision:

| Word | What it means on screen |
|---|---|
| **Quiet** | Chrome recedes. Panels are low-luminance translucent glass, text is soft white, and nothing moves unless the user moved it. The 3D scene owns the contrast. |
| **Exact** | Numbers are first-class: monospaced, aligned, copyable, with units always shown. Snap glyphs, measurement triangles and coordinates look like survey instruments, not decorations. |
| **Fluent** | One accent colour, one active tool, one place for everything. Every action is reachable in three ways: a visible control, a keyboard shortcut, and the command palette. |

### 1.1 What makes it different

These are the signature features that make VIEWER feel modern rather than "another Cesium app". Each one serves an SRS requirement; none is decoration.

1. **The Route Magenta accent.** A single magenta accent (borrowed from aviation charts, where magenta marks the route) for selection, measurements and the active tool. Magenta is almost absent from terrain, cities and vegetation, so a measurement line is visible on any imagery. It also stays clear of the red/orange/blue/green colours that classification banners commonly use.
2. **Measurement triangle.** While measuring, the canvas draws the right-angle triangle between two points: the 3D line in magenta, the horizontal and vertical legs as thin dashed lines, each with its own label. One glance shows 3D distance, horizontal distance and height difference (MSR-04), and the same three numbers appear in the sidebar card.
3. **Survey-grade snapping.** Distinct glyphs for what you are snapping to: a square for a vertex, a diamond for an edge midpoint/edge, a circle for a free surface point, with a crosshair and a short label ("Vertex · 2.4 px"). Borrowed from CAD, rare in web viewers (MSR-03).
4. **Library on the globe.** Every model is georeferenced (Q-03), so the library has a second view: a dark globe with the footprint of every model, coloured by status. Zoom to a city to see what exists there; click a footprint to open it. The grid and the globe share the same filters.
5. **Turntable cards.** Each library card shows a still thumbnail; on hover it scrubs through a 24-frame turntable rendered at conversion time. You see the model in 3D before opening it, at zero runtime cost.
6. **Command palette (Ctrl+K).** Every command, layer, measurement, model and setting is searchable. It also understands coordinates: type `31.7767, 35.2345` or `36N 711230 3517450` and the camera flies there. Works in Hebrew and English.
7. **Layer hover-glow and paint visibility.** Hovering a layer row outlines that layer in the 3D scene. Alt+click a row solos it (isolate, LYR-05). Dragging down the eye column toggles many layers in one stroke, like a paint brush.
8. **Calm motion that respects the operator.** Camera flights use one eased curve and always end exactly where the user expects. Panels slide on springs. Shadows and ambient occlusion fade in when the camera stops, so moving is fast and stopping looks rich. `prefers-reduced-motion` turns all of it into instant cuts.
9. **The hint line.** A single line of text at the bottom of the canvas always says what the active tool expects next: "Click the first point · Esc to cancel". New users never get lost; experts can ignore it (NFR-15).
10. **Classification you cannot miss and cannot remove.** A full-width banner at the top and bottom of the viewer in the admin-defined colour, also on cards, thumbnails, screenshots and exports, burned into pixels (UPL-10).

---

## 2. Layout

Reference screen: 1920 × 1080 (smallest supported, Q-09). All sizes in CSS pixels at 100% scaling.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  CLASSIFICATION BANNER (24 px)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
├──────────────────────────────────────────────────────────────────────────────┤
│ ◧ VIEWER  ‹ Library   Old City block 4  ● Current  v3 ▾   ⌘K Search…  ⤴ Share │ 48 px top bar
├────────┬───────────────────────────────────────────────────────────┬─────────┤
│ LAYERS │                                                     ┌───┐ │ MEASURE │
│ 🔍 ... │                                                     │ ▣ │ │ PROPS   │
│ ◉ ▸ T… │                      3D CANVAS                      └───┘ │         │
│ ◉ ▾ B… │                                                     view  │ ① 42.18 m│
│   ◉ …  │                                                     cube  │ ② path   │
│ ○ ▸ V… │                                                           │         │
│        │  N ↑                                                      │         │
│ 280 px │  ⊢——— 50 m ———⊣        Click the first point · Esc        │ 320 px  │
│        │            ┌─────────────────────────────────────┐        │         │
│        │            │ ⌂ ◎ │ ✥ ✋ │ ◐ ▾ │ 📏 ⟋ │ ⊘ │ ⚙ ?  │        │         │
│        │            └─────────────────────────────────────┘ dock   │         │
├────────┴───────────────────────────────────────────────────────────┴─────────┤
│ 31.776712° N  35.234519° E  812.4 m  WGS84 ▾     ◷ 60 fps  ● Server online   │ 28 px status bar
├──────────────────────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  CLASSIFICATION BANNER (24 px)  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Region | Size | Behaviour |
|---|---|---|
| Classification banners | 24 px top and bottom, full width | Always visible, including in full-screen mode. Text centred, uppercase, admin colour + admin text colour. Never translucent. |
| Top bar | 48 px | Back to library, model name, status badge, version picker, classification chip, command palette trigger, share link, language and theme menu. |
| Left panel (Layers) | 280 px (resizable 220–420) | Collapses to a 48 px icon rail (L key). Floating glass over the canvas, not docked, so the model never resizes when panels open. |
| Right panel (Measurements / Properties) | 320 px (resizable 260–480) | Collapses to a 48 px rail. Tabs at top. Opens automatically on first measurement. |
| Canvas | Remaining space | View cube 96 px top-right inside the canvas; compass + north arrow and scale bar bottom-left; hint line bottom-centre above the dock. |
| Dock | 52 px tall, floating, centred, 16 px above the status bar | Grouped tools with dividers; active tool has a magenta underline and filled icon. |
| Status bar | 28 px | Cursor coordinates (monospaced), coordinate system switch, fps (optional), server status pill (EXE shows online/offline). |
| Full-screen (F) | — | Hides top bar, panels, dock and status bar; keeps classification banners and the hint line. |

**Right-to-left.** In Hebrew the whole chrome mirrors: Layers move to the right, Measurements to the left, dock order reverses, text aligns right. Things that must **not** mirror: the 3D canvas, the view cube, the compass, the scale bar direction, coordinate and number strings (wrapped in `<bdi dir="ltr">`), and icons with a physical direction (orbit, pan arrows keep their meaning).

---

## 2A. Three layout directions (prototype, for the product owner to choose)

The product owner asked to keep the visualization space at the maximum, to consider a Google Earth style, and to see all the options before deciding. The prototype therefore runs **three layout directions on the same engine, tools and design tokens**. A switcher at the top of the prototype changes direction live; the chosen direction becomes the Release 1 layout and the other two are removed. Every SRS function is reachable in all three.

| | A. Earth workspace | B. Night Instrument | C. Minimal HUD |
|---|---|---|---|
| Home | The globe, with every model pinned where it is in the world, coloured by status. A search drawer on the left lists and filters models. | A library page: card grid with turntable thumbnails and filters, or the same library on the globe. | The globe with one spotlight search in the middle. |
| Opening a model | Fly in from the globe. The model header and Layers float on the left. | Click a card. Floating header at top, Layers left, Measurements right. | Pick from the spotlight. A small pill at the top names the model and its status. |
| Tools | Centred dock at the bottom, panels as floating glass that never resize the canvas. | Same dock and floating panels. | A thin icon rail on one edge. The dock and the rail fade out after 2.5 s without movement and return on any mouse move or key. |
| Canvas share at 1920 × 1080, panels closed | About 96 % (only the classification banners are fixed). | About 96 % in the viewer, 0 % on the library page. | About 96 %, close to 100 % while the chrome is faded. |
| Best for | Operators who think in places: "what do we have around here?" | Users who think in projects and versions, and producers checking status. | Briefings and demonstrations, large screens, users who mostly look. |
| Risk | The globe is busy at country zoom when there are thousands of models (needs clustering). | One extra step from home to the 3D view. | Hidden controls are less discoverable for first-time users (mitigated by the hint line, ? overlay and Ctrl+K). |

The fixed top bar and status bar in section 2 apply to direction B only. Directions A and C replace them with floating elements, so the canvas runs edge to edge between the classification banners. In every direction, **F** hides everything except the banners and the hint line.

### 2A.1 Fly-by (all directions)

Added at the product owner's request. Three ways to fly, all in the **Fly-by** tab of the right panel and in the command palette:

1. **Orbit tour.** The camera circles the model's bounding sphere once in 40 s at a pleasant oblique angle. Any mouse or key input stops it.
2. **Viewpoint tour.** Save viewpoints while you explore (camera position, heading, pitch); play them back as a smooth loop with eased flights between them. Viewpoints are saved with the model's measurements.
3. **Fly mode (G).** Free flight: W A S D to move, Q E for down and up, drag to look, Shift for speed. Speed scales with height above the surface, so the same keys work over a city and inside a room. Esc returns to normal navigation.

---

## 3. Screens

### 3.1 Library

- **Header:** search field (searches name, project, operation, responsible entity, description in Hebrew and English), view switch **Grid | Globe**, Upload button (primary).
- **Filter bar:** chips for Project, Operation, Status, Responsible entity, Classification. Active filters show as removable magenta-outlined chips with counts.
- **Grid:** cards 280 × 248 px, 16 px gap, responsive columns. Card: classification ribbon (6 px top edge, admin colour), thumbnail 280 × 158 with turntable on hover, model name (2 lines max), project · operation, status badge with icon + text, version and last-changed date, format icon (GLB / 3D Tiles / FBX source).
- **Globe:** the same filtered set as footprints on a dark globe; footprints coloured by status; hover shows a mini card; click opens the model; a list on the side mirrors visible footprints.
- **Empty states:** "No models yet. Drag a model here or click Upload" with a drop target that covers the whole page.
- **Loading:** skeleton cards with a slow shimmer; no spinners.

### 3.2 Viewer

- Opens with a **camera flight** from the globe to the model's bounding sphere (about 1.2 s, skippable with any input).
- 3D Tiles refine progressively; a thin progress line under the top bar shows tile loading (no blocking overlay).
- **First-run coach marks** (once per workstation, dismissible): three steps pointing at orbit/pan, Layers and Measure. This plus the hint line is how NFR-15 (open, navigate and measure without training) is met.
- **Error states** (FMT-05): a calm card in the centre of the canvas: icon, file name, plain-language reason, technical detail collapsed, "Back to library" and "Copy details". The app keeps running.

### 3.3 Measurement

- Tools: **Distance** (M) and **Path** (Shift+M). Click to place points; double-click or Enter finishes a path; Backspace removes the last point; Esc cancels.
- Live label follows the cursor with the 3D distance; the measurement triangle shows horizontal and vertical legs.
- **Sidebar card** per measurement: editable label (auto "Distance 1"), 3D distance (large, monospaced), horizontal, height difference, number of segments and total for paths, per-segment list (collapsed), units toggle (m / ft) shared across cards, actions: show/hide, copy values, copy coordinates, delete.
- Measured points show their coordinates in the chosen system on hover; Ctrl+C copies.
- "Model units" warning chip when MSR-06 applies.

### 3.4 Upload wizard (producers)

A full-screen sheet with five steps. Progress for every step is visible at the top; the user can leave and come back while conversion runs.

| Step | Content | Requirements |
|---|---|---|
| 1. Drop | Drag files, a folder or a ZIP; or pick. Shows each file with size; resumable upload progress per file; "You can keep working, we'll notify you" | UPL-01, 03 |
| 2. Check | Live validation checklist (format, textures, tiles, size, antivirus) with every problem listed and how to fix it | UPL-02, FMT-05 |
| 3. Place | Detected georeference shown on a map with the footprint; if missing, enter origin + CRS (searchable EPSG list, ITM and UTM 36N first) and see the footprint move live | FMT-08 |
| 4. Layers | Layer editor: proposed tree on the left, standard names on the right; drag to rename, merge, nest and reorder; "Apply suggestions" button; carried over from the previous version | UPL-09 |
| 5. Details | Project, operation (with autocomplete from existing values), update status, responsible entity, description, classification (admin list with colours); preview of the library card | UPL-04, 05, 10 |

### 3.5 Admin (password-protected)

Classification levels (name, banner colour, text colour, order), base map sources (offline package paths, WMTS URL + layer), storage quotas and usage, permanent delete with typed confirmation, audit log viewer with filters and export.

---

## 4. Visual design tokens

All colours were checked for WCAG 2.1 AA contrast (≥ 4.5:1 for text) against the panel and canvas colours below (NFR-17).

### 4.1 Dark theme (default)

| Token | Hex | Use | Contrast on panel `#15171B` |
|---|---|---|---|
| `canvas.bg` | `#1B1D21` | 3D background and empty sky in model-only mode (neutral grey so textures read true) | — |
| `surface.1` | `#15171B` at 82% + 24 px backdrop blur | Panels, dock | — |
| `surface.2` | `#1E2127` | Cards, inputs, hovered rows | — |
| `border` | `#2C3038` | 1 px hairlines | — |
| `text.primary` | `#E8EAED` | Main text | 14.9:1 |
| `text.secondary` | `#A7ADB8` | Labels, metadata | 8.0:1 |
| `text.tertiary` | `#8A919D` | Hints, placeholders | 5.7:1 |
| `accent` | `#F05BDC` Route Magenta | Selection, measurements, active tool, focus ring | 6.2:1 |
| `status.inProduction` | `#F2B33D` | Status badge | 9.7:1 |
| `status.current` | `#3DD68C` | Status badge | 9.6:1 |
| `status.superseded` | `#8F98A8` | Status badge | 6.2:1 |
| `status.draft` | `#A7ADB8` | Status badge | 8.0:1 |
| `danger` | `#FF6B6B` | Errors, destructive actions | 6.5:1 |

### 4.2 Light theme

| Token | Hex | Contrast on `#FFFFFF` |
|---|---|---|
| `canvas.bg` | `#DADDE2` | — |
| `surface.1` | `#FFFFFF` at 88% + blur | — |
| `text.primary` | `#14161A` | 18.1:1 |
| `text.secondary` | `#4A515C` | 8.0:1 |
| `text.tertiary` | `#5E6570` | 5.9:1 |
| `accent` | `#A3128C` | 7.0:1 |
| `status.inProduction` | `#8A5A00` | 5.9:1 |
| `status.current` | `#0F7A47` | 5.4:1 |
| `danger` | `#C0262D` | 5.9:1 |

Status is never colour-only: every badge has an icon and a word (Draft ◌, In production ◐, Current ●, Superseded ⊘).

### 4.3 Typography

| Role | Font | Size / line height | Weight |
|---|---|---|---|
| Display (library title) | IBM Plex Sans / Plex Sans Hebrew | 24 / 32 | 600 |
| Title (panel headers) | same | 15 / 20 | 600 |
| Body | same | 13 / 20 | 400 |
| Label / caption | same | 12 / 16 | 500, +0.2 px tracking (Latin only) |
| Numbers, coordinates | IBM Plex Mono | 13 / 20; large readout 22 / 28 | 500, tabular figures |

Fonts are bundled (OFL-1.1); no external font requests. Hebrew and Latin come from the same family so mixed metadata looks consistent.

### 4.4 Shape, space, elevation

- 4 px base grid; components on 8 px steps. Panel padding 16 px; row height 32 px (compact) for trees and lists.
- Radius: 6 px controls, 10 px cards, 14 px panels and dock.
- Elevation by light, not shadow: panels get a 1 px top inner highlight `rgba(255,255,255,0.06)` and a soft outer shadow only in light theme.
- Icons: Lucide, 1.5 px stroke at 20 px; custom 3D tool icons drawn on the same grid.

### 4.5 Motion

| Movement | Duration | Easing |
|---|---|---|
| Hover, press, toggle | 120 ms | `cubic-bezier(0.2, 0, 0, 1)` |
| Panel open / close | spring, stiffness 420, damping 40 (~240 ms) | spring |
| Camera fly-to (Home, Focus, view cube) | 600–1200 ms by distance | ease-in-out cubic |
| Shadows / AO fade-in after camera stops | 250 ms after 150 ms idle | linear |
| Toasts | 180 ms in, 4 s stay, 140 ms out | — |

`prefers-reduced-motion`: all transitions become instant, camera flights become cuts.

---

## 5. Interaction model

### 5.1 Mouse, touch, keyboard (SRS 5.1)

| Action | Mouse / touch | Keyboard |
|---|---|---|
| Orbit | Left-drag around pivot (pivot set by double-click; shown as a small magenta ring for 1 s) | W (orbit mode) |
| Pan | Right-drag or middle-drag; two-finger drag | E (pan mode), arrow keys |
| Zoom | Wheel / pinch toward cursor; dock + / − | + / − |
| Walk (later, NAV-06) | — | R (reserved) |
| Home | Dock ⌂, view cube home | H |
| Focus selection | Dock ◎, double-click layer row | Z |
| Measure distance / path | Dock | M / Shift+M |
| Layers panel / Measurements panel | Rail icons | L / . |
| Full screen | — | F |
| Command palette | Top bar | Ctrl+K |
| Help overlay | Dock ? | ? |
| Cancel tool | — | Esc |
| View modes | Dock ◐ menu | 1 Shaded · 2 Edges · 3 Wireframe · 4 Unlit |

Shortcuts are identical in web and EXE, and identical in Hebrew (they follow physical key positions, not letters).

### 5.2 Rules

- **One active tool.** Selecting a tool deactivates the previous one. The active tool is visible in the dock and the hint line until Esc.
- **No modal dialogs over the model** except destructive confirmations. Everything else is a panel, popover or toast.
- **Everything copyable.** Any number or coordinate copies on click with a small "Copied" tick.
- **Undo where it matters.** Isolate, hide all, and delete measurement have Ctrl+Z.
- **Remembered per workstation** (local storage): language, theme, coordinate system, units, panel sizes, quality preset.

---

## 6. Accessibility and language

- WCAG 2.1 AA contrast in both themes (section 4). Focus ring: 2 px magenta + 2 px offset, always visible on keyboard focus.
- Every icon button has a tooltip with its name and shortcut, and an `aria-label` in both languages.
- Layer tree implements the ARIA tree pattern (arrow keys, Space toggles visibility).
- Minimum hit target 32 × 32 px.
- Hebrew/English switch is instant (no reload); dates and numbers use the locale formatter; numbers stay Western digits in both languages.

---

## 7. Design process and deliverables

| When | Deliverable |
|---|---|
| Phase 0, week 1 | Mood board + 3 directions for the viewer screen (this spec is direction A) |
| Phase 0, week 2 | Tokens, components, key screens in high fidelity; dark/light; LTR/RTL |
| Phase 0, week 3 | Clickable prototype; 5 hallway tests with analysts; product-owner sign-off |
| Phase 1–4 | Component specs ahead of each WP; weekly design review on the running build |
| Phase 6 | Usability test for NFR-15; polish pass |

Design tool: **Penpot** (MPL-2.0, self-hostable) so designs can live on the internal network too; Figma is fine during the internet-side design phase if allowed.

The design system lives in code in `packages/ui`, with a catalogue page showing every component in both themes and both directions. It is the source of truth once Phase 1 starts.
