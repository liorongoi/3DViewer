# {{app}} user manual

{{app}} shows 3D models of real places on a globe, with the ground, the map and your own data around them. You can find a model in the library, look around it, hide and show its parts, measure it, check what can be seen from a point, and share the view with a colleague. This manual covers the web app and the desktop app. They work the same way, except where a section says otherwise.

## Getting started

### Opening the app

- **Web app:** open the address your organisation gave you in Chrome or Edge. The app needs WebGL 2, which every current browser has. The page title says **{{app}}**.
- **Desktop app (Windows):** start **{{app}}** from the Start menu. It connects to the same library server as the web app. It also opens model files from your own computer, even when the server cannot be reached.

The first time you open a model, three short tips show how to move around, where the layers are and how to measure. Choose **Got it** to close each one.

### The screen

![The library: every model the server holds, with filters at the top](img/library.png)

- **Classification banner** at the top and bottom of the window. It always shows the classification of what is on screen. On the globe with no model open, it shows the lowest level.
- **Library** on the left: the models, with search and filters.
- **3D view** in the middle: the globe, the terrain and the open model.
- **Toolbar** at the bottom: navigation, view modes, measuring and analysis tools, settings and help.
- **Side panels:** **Layers** and **Map & data** on the left, and **Measurements**, **Analysis**, **Properties** and **Fly-by** on the right. <kbd>L</kbd> shows or hides the left panel and <kbd>.</kbd> shows or hides the right one.
- **Server status** in the corner: **Server online** or **Offline**. When offline, files on this computer still open, and the app reconnects by itself.

## Finding a model

Type in the library's search box to find a model by its name, project, operation or responsible entity. The filters narrow the list by **Project**, **Operation**, **Status**, **Responsible entity** and **Classification**. **Clear filters** shows everything again.

Each card shows the model's thumbnail, version, status and the date it last changed. Choose the card, or **Open**, to open the model.

Each model is also a pin on the globe, where it stands. Choose a pin to open its model.

### Versions

A model can have several versions. The **Version** button at the top of the viewer shows which one is open (for example **v2 of 3**). Choose it to see every version with its date and note, and to open an older one. The current version is marked **Current**, and older ones are marked **Superseded**.

## Moving around

| Action | Mouse | Keyboard |
|---|---|---|
| Orbit around the pivot | Left-drag | <kbd>W</kbd> sets left-drag to orbit |
| Pan | Right-drag or middle-drag | <kbd>E</kbd> sets left-drag to pan; arrow keys |
| Zoom toward the cursor | Wheel, or pinch on a touchpad | <kbd>+</kbd> and <kbd>−</kbd> |
| Set the pivot | Double-click a point | |
| Fit the whole model | | <kbd>H</kbd> (Home) |
| Focus on the selected part | | <kbd>Z</kbd> |
| Fly mode | | <kbd>G</kbd>, then <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd>, <kbd>Q</kbd> / <kbd>E</kbd> |
| Full screen | | <kbd>F</kbd> |

The **view cube** in the corner shows which way you are looking. Choose a face, an edge or a corner to look from that side. The scale bar and the coordinates under the cursor are at the bottom. <kbd>Ctrl</kbd> <kbd>C</kbd> copies the coordinates under the cursor.

### View modes

<kbd>1</kbd> to <kbd>4</kbd>, or the **View mode** button on the toolbar, switch between **Shaded**, **Shaded with edges**, **Wireframe** and **Unlit (texture only)**.

### Fly mode

**Fly mode** (<kbd>G</kbd>) is drone-style flight. Use <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd> to move and <kbd>Q</kbd> / <kbd>E</kbd> to go down and up, and drag to look around. Hold <kbd>Shift</kbd> for four times the speed. The speed follows your height above the ground. <kbd>Esc</kbd> leaves fly mode.

![The open model, with the toolbar at the bottom](img/viewer.png)

## Layers

![The Layers panel: the model's parts, in the model's own order](img/layers.png)

The **Layers** panel (<kbd>L</kbd>) lists the model's parts in the file's own order and nesting.

- Choose the **eye** to hide or show a part. Hiding a group hides everything in it, and each part keeps its own setting.
- Drag down the eyes to hide or show several parts in one go.
- <kbd>Alt</kbd>+click an eye, or choose **Isolate**, to show only that part. **Undo isolate** brings back what was shown before.
- **Show all** and **Hide all** act on every part.
- **Search layers** keeps the matching parts and their groups, with the matching text marked.
- Pointing at a row outlines that part in 3D. Choosing a part in 3D selects its row.

### Arranging the layers

**Arrange layers** renames, nests, merges and reorders the parts, and can gather them under the standard names (**Terrain**, **Buildings**, **Infrastructure**, **Vegetation**, **Water**, **Other**). Drag a row by its handle: drop it on the top or bottom edge of another row to place it there, or on its middle to nest it. The arrangement is saved for everyone on the current version, and the next version starts from it. **Back to the file's own layers** undoes it. Layers can only be arranged on the current version.

## Measuring

![A distance measured on the model, with its values in the Measurements panel](img/measure.png)

- **Measure distance** (<kbd>M</kbd>): choose two points. The panel shows the **3D distance**, the **Horizontal** distance and the **Height difference**.
- **Measure path** (<kbd>Shift</kbd> <kbd>M</kbd>): choose each point in turn. Double-click or press <kbd>Enter</kbd> to finish, and <kbd>Backspace</kbd> removes the last point. The panel shows the **Total length** and each segment.

Points snap to the model's corners and edges within 10 pixels. The label next to the cursor says **Vertex** or **Edge**. Hold <kbd>Alt</kbd> while you click to place a point exactly where you click, with no snapping. <kbd>Esc</kbd> cancels the tool.

The **Measurements** panel (<kbd>.</kbd>) lists every measurement. There you can switch **Units** between **Metres** and **Feet**, choose the **Coordinate system** (WGS84 or UTM with its zone), **Copy values**, **Copy coordinates** and delete a measurement. Heights are above the WGS84 ellipsoid.

> A model with no reliable scale is measured in **model units**, not metres. The panel says so.

## Analysis

![The Analysis panel](img/analysis.png)

### Line of sight

**Line of sight** (<kbd>I</kbd>) answers whether point A can see point B. Choose the observer point A, then the target point B. You can add as many pairs as you like, and <kbd>Esc</kbd> stops. Each pair shows **Visible** or **Blocked** and where it is blocked, with a height profile of the ground, the buildings and models, and the sight line. You can set the **Observer above ground** and **Target above ground** heights, and choose whether to allow for the Earth's curvature with standard refraction. **Export CSV** saves the pairs, and **Profile CSV** saves one profile.

### 360° visibility

**360° visibility** (<kbd>V</kbd>) shows everything an observer can see within a radius. Choose where the observer stands. Ground and walls that can be seen turn green, and hidden ones turn red. Drag the white eye to move the observer, and <kbd>Shift</kbd>+drag up or down to change its height. The map updates as you move. Set the **Eye height above ground** and the **Radius**. **Visible area** works out how much of the ground within the radius can be seen, and **GeoTIFF** saves it as a map for a GIS.

## Map & data

![The Map & data panel: base map, terrain and your own data](img/map.png)

The **Map & data** tab in the left panel chooses the **Base map** and the **Terrain**. Sources marked **site** come from your organisation's own map servers. Sources marked **online** need the internet. The bundled world map always works, even with no network.

### Your own data

Drop files on the panel, or choose **Add files**:

- **Shapefile** (.shp with its .dbf and .prj, or a .zip), **GeoJSON** and **KML**: drawn on the ground and on models. Choose a feature to see its attributes.
- **GeoTIFF** and **Cloud-Optimised GeoTIFF** in any coordinate system: drawn as imagery. A single-band elevation file is drawn as shaded relief, and **Use as terrain** shapes the 3D ground with its heights inside its footprint.

**Add map service** connects to a **WMTS** or **WMS** service from its address (GetCapabilities), to **XYZ** tiles, or to a GeoTIFF on a server. Choose **Connect**, then **Add** next to the layer you want. **As base** uses it as the base map.

Each layer has an opacity slider, **Zoom to layer**, **Move up**, **Move down** and **Remove**. Layers are saved with the view.

## Properties and level of detail

![The Properties panel](img/properties.png)

**Properties** shows the model's details: format, classification, project, operation, responsible entity and description. **Edit details** changes them for everyone, and the change is recorded in the audit log. **Height on the terrain** raises or lowers the model, and **Reset** puts it back on the ground.

**Level of detail** controls how fine a streamed (tiled) model is drawn. Use the **Detail** slider, or **Full detail: every triangle**, which loads the finest level everywhere and uses the most memory. **Colour tiles by depth**, **Show tile bounding boxes** and **Freeze the selection** help you see which parts of a large model are loaded. The panel also shows how many tiles are drawn and loaded, and the GPU memory in use.

## Fly-by

![The Fly-by panel](img/flyby.png)

- **Cinematic orbit:** one slow orbit around the model with a gentle rise and fall. Any input stops it.
- **Viewpoint tour:** choose **Save this view** for two or more views, then **Play tour** to fly smoothly between them on a loop.

## Sharing and screenshots

- **Share view** copies a link to this view: the model, its version, the camera and your measurements. Anyone with access to the library who opens the link sees the same view. Models you opened from your own computer, or uploaded in this session, cannot be shared yet.
- **Screenshot with classification** saves an image of the view with the classification banner on it.

## Command palette

![The command palette](img/palette.png)

<kbd>Ctrl</kbd> <kbd>K</kbd> opens the command palette. Type a command, a layer, a model, or coordinates (for example `31.77, 35.23`), then choose a result. Coordinates fly the camera to that place.

## Uploading a model

![Upload a model](img/upload.png)

**Upload model** in the library opens a wizard with five steps:

1. **Drop:** drag in an FBX, a glTF (a folder or a ZIP), a GLB, or a 3D Tiles folder or ZIP. Each file can be up to 2 GB, and a tileset up to 50 GB.
2. **Check:** the app checks the format, the textures and the size. The antivirus scan runs on the server when you publish.
3. **Place:** where the model is. If the file has its own position, the app uses it. Otherwise choose a coordinate system (WGS 84, the Israeli TM Grid, UTM 36N or Israeli Grid 05/12) and enter the origin, height, heading, up axis and units. The size as placed is shown, so wrong units stand out.
4. **Layers:** rename, merge, nest and reorder the parts. **Apply suggestions** gathers them under the standard names.
5. **Details:** the model's name, project, operation, status, responsible entity, description and classification. Then choose **Publish**.

The server checks the files again, scans them, converts an FBX, validates the model, tiles a large model for streaming and compresses it, then publishes it to the library. Each step is shown as it runs. An upload resumes by itself if the connection drops.

> **Desktop app:** **Keep on this computer only** opens the model here without sending it to the server. FBX files are converted on your own computer.

## Settings

![Settings](img/settings.png)

The **Settings** button on the toolbar has:

- **Language** (English or Hebrew) and **Theme** (dark or light).
- **Quality** (**Low**, **Balanced**, **High** or **Ultra**) and **Tiles memory**, which caps the memory used for streamed models.
- **Lighting:** **Sky and sun**, **Overcast**, **Clear noon** or **Studio neutral**, plus sun shadows.
- **Fade tools while navigating**, and **Lower the resolution while frames are slow**.
- **Performance overlay** (<kbd>Shift</kbd> <kbd>P</kbd>), which shows the frame rate, frame time, tiles and memory.

These settings are kept on this computer.

## Administration

![Administration](img/admin.png)

**Settings ▸ Administration…** needs the admin password. Every sign-in, and every wrong password, is recorded in the audit log.

- **Classification levels:** the levels, their names and their banner colours, lowest first. The text must have a contrast of at least 4.5:1 on its band.
- **Base maps:** this site's own map servers (WMTS, WMS, TMS, XYZ, terrain), and the base map and terrain the viewer opens with. **Hide the internet sources** leaves only the site's own sources.
- **Storage:** the space used by published versions and uploads in progress, and an optional quota.
- **Delete models:** removes a model, every version and all its files from the server. It cannot be undone. The audit log keeps a record of it.
- **Audit log:** every view, upload, change, sign-in and delete, with its address and workstation. **Check the chain** confirms that no entry was edited, and **Export CSV** saves the log.
- **Password:** change the admin password. It must be at least 12 characters.

## Keyboard shortcuts

![Keyboard and mouse help (?)](img/help.png)

| Key | Action |
|---|---|
| <kbd>?</kbd> | Keyboard and mouse help |
| <kbd>Ctrl</kbd> <kbd>K</kbd> | Command palette |
| <kbd>H</kbd> | Home: fit the whole model |
| <kbd>Z</kbd> | Focus on the selection |
| <kbd>W</kbd> / <kbd>E</kbd> | Left-drag orbits / pans |
| Arrow keys, <kbd>+</kbd> <kbd>−</kbd> | Pan, zoom |
| <kbd>G</kbd> | Fly mode |
| <kbd>1</kbd>–<kbd>4</kbd> | View modes |
| <kbd>M</kbd> | Measure distance |
| <kbd>Shift</kbd> <kbd>M</kbd> | Measure path |
| <kbd>I</kbd> | Line of sight |
| <kbd>V</kbd> | 360° visibility |
| <kbd>Alt</kbd> | Hold while clicking: place a point without snapping |
| <kbd>L</kbd> | Show or hide the left panel |
| <kbd>.</kbd> | Show or hide the right panel |
| <kbd>F</kbd> | Full screen |
| <kbd>Shift</kbd> <kbd>P</kbd> | Performance overlay |
| <kbd>Esc</kbd> | Cancel the active tool |

The shortcuts follow the keys' positions, so they work the same with a Hebrew keyboard layout.

## When something goes wrong

- **"WebGL 2 is required":** the browser or the graphics driver cannot draw 3D. Update the browser, or ask IT to update the graphics driver.
- **Offline:** the library server does not answer. Models already open keep working, files on this computer still open, and the app reconnects by itself.
- **"This model could not be opened":** **Technical details** shows why. **Back to library** returns to the library.
- **"Some tiles could not be loaded":** the rest of the model is shown, with holes where those tiles should be. Reopening the model usually loads them.
- **"Something went wrong in this part of the interface":** only that part stopped. The 3D view and the rest of the app still work. **Try again** restarts that part, and **Reload** reloads the app.
- **Slow on a large model:** lower **Quality** or **Detail**, or switch on **Lower the resolution while frames are slow**.
